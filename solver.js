const puppeteer = require('puppeteer-core');

/**
 * แกนกลางสำหรับดึง KEY จาก Platoboost / Delta
 * - แยกออกจาก server เพื่อให้เรียกซ้ำได้ และคุม timeout ได้
 *
 * [v2] ปรับให้เร็วขึ้น:
 *   - เลิกใช้ waitUntil: 'networkidle2' (รอฟรี) เปลี่ยนเป็น domcontentloaded
 *   - เลิกใช้ sleep ตายตัว (3.5s / 4s) เปลี่ยนเป็น "รอจนพร้อมจริง" (event-driven)
 *   - ยังมี fallback timeout กันตายทุกจุด
 *
 * [v4] รองรับหน้า Key System รูปแบบใหม่:
 *   - หน้าเลือกผู้ให้บริการมีทั้ง "Lootlabs (1 step)" และ "or continue with linkvertise (2 step)"
 *   - เดิมโค้ดเลือกปุ่มจาก class bg-primary ทำให้ไปโดน Lootlabs → วนซ้ำจนหมดเวลา
 *   - แก้ให้เลือกจากข้อความ "linkvertise" และรองรับปุ่มนับถอยหลัง (disabled) + ปุ่ม Continue ขั้นสุดท้าย
 *
 * [v3] ประหยัดสเปค (reuse browser):
 *   - เปิด Chrome ไว้ตัวเดียว ใช้ซ้ำทุกงาน (เดิมเปิด-ปิดใหม่ทุกงาน)
 *   - แต่ละงานได้ browser context แยกของตัวเอง → cookie/storage ไม่ปนกัน
 *   - รีไซเคิล Chrome ใหม่ทุก RECYCLE_AFTER งาน กัน memory leak
 */

const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';

// ===== จูนความเร็วได้ที่นี่ =====
const GOTO_TIMEOUT_MS = 30000;   // รอโหลดหน้า (สูงสุด)
const READY_TIMEOUT_MS = 8000;   // รอหน้าเว็บพร้อม (ปุ่มโผล่) สูงสุด
const REDIRECT_TIMEOUT_MS = 8000; // รอ Linkvertise เด้ง สูงสุด
const SETTLE_MS = 700;           // พักสั้นๆ หลังคลิก ก่อนอ่าน DOM
const POLL_INTERVAL_MS = 150;    // ความถี่ในการเช็ค

// ===== จูนการรีไซเคิลเบราว์เซอร์ =====
const RECYCLE_AFTER = Number(process.env.RECYCLE_AFTER) || 40; // ปิด-เปิด Chrome ใหม่ทุก N งาน

// ===== จูนการปิด Chrome ตอนว่าง =====
// ไม่มีงานเข้าเกิน IDLE_CLOSE_MS -> ปิด Chrome คืน RAM (งานถัดไปค่อยเปิดใหม่ ~1-2 วิ)
const IDLE_CLOSE_MS = Number(process.env.IDLE_CLOSE_MS) || 5 * 60 * 1000; // ค่าเริ่มต้น 5 นาที

// flags ที่ปลอดภัย: ปิดของที่ไม่ใช้ในโหมด headless (ไม่กระทบการเปิดแท็บ/นำทาง)
// ⚠️ ห้ามใส่ --single-process / --renderer-process-limit เพราะโค้ดนี้พึ่งการเปิดแท็บใหม่ (Linkvertise)
const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-blink-features=AutomationControlled',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--disable-extensions',
  '--disable-sync',
  '--disable-translate',
  '--disable-background-networking'
];

// ===== เบราว์เซอร์ที่ใช้ร่วมกันทุกงาน =====
let sharedBrowser = null;
let launchPromise = null;
let jobsSinceLaunch = 0;
let activeJobs = 0;      // จำนวนงานที่กำลังรัน (กัน idle timer ปิด Chrome กลางงาน)
let idleTimer = null;    // ตัวจับเวลาปิด Chrome ตอนว่าง

/** ยกเลิกการปิด Chrome ตอนว่าง (เรียกเมื่อมีงานเข้า) */
function cancelIdleClose() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

/** นัดปิด Chrome ถ้าไม่มีงานเข้าเกิน IDLE_CLOSE_MS */
function scheduleIdleClose() {
  cancelIdleClose();
  if (IDLE_CLOSE_MS <= 0) return;
  idleTimer = setTimeout(async () => {
    idleTimer = null;
    // กันพลาด: ถ้ามีงานแทรกเข้ามาพอดี ให้เลื่อนไปนัดใหม่แทน
    if (activeJobs > 0) {
      scheduleIdleClose();
      return;
    }
    if (sharedBrowser) {
      console.log(`💤 ไม่มีงาน ${Math.round(IDLE_CLOSE_MS / 1000)} วิ — ปิด Chrome คืน RAM`);
      await closeBrowser();
    }
  }, IDLE_CLOSE_MS);
}

/** คืนเบราว์เซอร์ตัวกลาง (เปิดใหม่ถ้ายังไม่มี หรือตัวเดิมหลุด) */
async function getBrowser() {
  if (sharedBrowser && sharedBrowser.connected) return sharedBrowser;

  if (!launchPromise) {
    launchPromise = puppeteer
      .launch({ executablePath: CHROME_PATH, headless: 'new', args: LAUNCH_ARGS })
      .then((b) => {
        sharedBrowser = b;
        jobsSinceLaunch = 0;
        // ถ้า Chrome ตายกลางทาง ให้ล้างอ้างอิง เพื่อเปิดใหม่ในงานถัดไป
        b.on('disconnected', () => {
          if (sharedBrowser === b) sharedBrowser = null;
        });
        return b;
      })
      .finally(() => {
        launchPromise = null;
      });
  }

  return launchPromise;
}

/** ปิด Chrome ตัวกลาง (เรียกตอน timeout, ตอนว่าง, หรือตอนรีไซเคิล) */
async function closeBrowser() {
  cancelIdleClose();
  const b = sharedBrowser;
  sharedBrowser = null;
  jobsSinceLaunch = 0;
  if (b) {
    try {
      await b.close();
    } catch (e) {}
  }
}

/** นับงานที่ใช้ Chrome ตัวนี้ ถ้าครบกำหนดก็รีไซเคิล */
async function recycleIfNeeded() {
  jobsSinceLaunch++;
  if (jobsSinceLaunch >= RECYCLE_AFTER) {
    await closeBrowser();
  }
}

// ===== โหมด debug: เก็บ URL เต็ม + สภาพหน้าเว็บ + แคปหน้าจอ =====
// เปิดด้วย DEBUG_SOLVER=1 (ดูรายละเอียดทุกขั้นตอนใน pm2 logs)
const DEBUG = process.env.DEBUG_SOLVER === '1' || process.env.DEBUG_SOLVER === 'true';
const DEBUG_DIR = process.env.DEBUG_DIR || '/tmp/opencode';

/** พิมพ์ข้อความ/ปุ่ม/ลิงก์ทั้งหมดในหน้าปัจจุบัน (เฉพาะโหมด debug) */
async function dumpPage(page, tag, log) {
  if (!DEBUG) return;
  try {
    const info = await page.evaluate(() => {
      const text = document.body ? document.body.innerText : '';
      const buttons = Array.from(document.querySelectorAll('button')).map((b) => ({
        text: b.innerText.trim().slice(0, 80),
        disabled: b.disabled,
        cls: (b.className || '').toString().slice(0, 60)
      }));
      const links = Array.from(document.querySelectorAll('a')).map((a) => ({
        text: a.innerText.trim().slice(0, 50),
        href: (a.href || '').slice(0, 120)
      }));
      return { url: location.href, text: text.slice(0, 1200), buttons, links };
    });
    log(`🔍 [${tag}] url = ${info.url}`);
    log(`🔍 [${tag}] text = ${JSON.stringify(info.text)}`);
    log(`🔍 [${tag}] buttons = ${JSON.stringify(info.buttons)}`);
    log(`🔍 [${tag}] links = ${JSON.stringify(info.links)}`);
  } catch (e) {
    log(`🔍 [${tag}] dump error: ${e.message}`);
  }
}

/** แคปหน้าจอ (เฉพาะโหมด debug) */
async function debugShot(page, tag) {
  if (!DEBUG) return;
  try {
    await page.screenshot({ path: `${DEBUG_DIR}/solver_${tag}.png`, fullPage: true });
  } catch (e) {}
}

function decodeBase64(str) {
  try {
    return Buffer.from(decodeURIComponent(str), 'base64').toString('utf-8');
  } catch (e) {
    return null;
  }
}

function isValidUrl(url) {
  return typeof url === 'string' && (url.includes('platorelay.com') || url.includes('platoboost'));
}

/** หน่วงเวลาแบบสั้น */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * รอจนเงื่อนไขเป็นจริง (event-driven) — คืน true ถ้าทันเวลา, false ถ้าหมดเวลา
 * ปลอดภัย: จับ error ทุกครั้ง (เช่น frame ถูก detached ระหว่างรอ)
 */
async function waitFor(predicate, timeout = READY_TIMEOUT_MS) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (await predicate()) return true;
    } catch (e) {}
    await sleep(POLL_INTERVAL_MS);
  }
  return false;
}

/** อ่านสถานะหน้าเว็บ (text + ปุ่ม) แบบกันพัง */
async function readPage(page) {
  return page.evaluate(() => {
    const text = document.body ? document.body.innerText : '';
    const buttons = Array.from(document.querySelectorAll('button')).map((b) => ({
      text: b.innerText.trim(),
      disabled: b.disabled
    }));
    return { text, buttons };
  });
}

/**
 * ดึง KEY จาก URL ที่ให้มา
 * @param {string} startUrl
 * @param {{timeoutMs?: number, onLog?: (msg:string)=>void}} options
 * @returns {Promise<string>} KEY ที่ได้
 */
async function solvePlatoboost(startUrl, options = {}) {
  const timeoutMs = options.timeoutMs || 90000;
  const log = options.onLog || (() => {});

  if (!isValidUrl(startUrl)) {
    throw new Error('URL ไม่ถูกต้อง (ต้องเป็นลิงก์ Platoboost / Platorelay)');
  }

  // เข้างาน: หยุดนาฬิกาปิด Chrome ตอนว่าง + นับงานที่กำลังรัน
  activeJobs++;
  cancelIdleClose();

  let context = null;
  let finished = false;
  let timedOut = false;

  // ตัวจับเวลารวม: ถ้าเกินกำหนด จะยกเลิกงาน (ปิด context + รีสตาร์ท Chrome)
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (!finished) {
        timedOut = true;
        reject(new Error(`หมดเวลา (เกิน ${Math.round(timeoutMs / 1000)} วินาที)`));
      }
    }, timeoutMs);
  });

  const work = (async () => {
    const browser = await getBrowser();

    // ✅ ใช้ context แยกต่องาน → cookie/storage ไม่ปนกัน (เหมือนเปิด Chrome ใหม่)
    context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    );

    let finalKey = null;

    // ดักฟัง Response เพื่อจับ KEY ทันทีที่ปล่อยออกมา
    page.on('response', async (res) => {
      if (res.url().includes('/api/session/status')) {
        try {
          const json = await res.json();
          if (json && json.data && json.data.key && json.data.key !== 'KEY_NOT_FOUND') {
            finalKey = json.data.key;
          }
        } catch (e) {}
      }
    });

    /** หา URL ของ Linkvertise จากทุกแท็บใน context ของงานนี้ */
    const findLinkvertise = async () => {
      try {
        const pages = await context.pages();
        for (const p of pages) {
          const u = p.url();
          if (u.includes('linkvertise.com')) return u;
        }
      } catch (e) {}
      return null;
    };

    let currentUrl = startUrl;
    const maxSteps = 10;
    let stepCount = 0;

    while (stepCount < maxSteps && !finalKey) {
      stepCount++;
      log(`[ขั้นตอนที่ ${stepCount}] เปิดหน้า: ${DEBUG ? currentUrl : currentUrl.slice(0, 70) + '...'}`);

      // ✅ เปลี่ยนจาก networkidle2 → domcontentloaded (ไม่รอฟรี)
      try {
        await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS });
      } catch (e) {
        log(`เปิดหน้าไม่สมบูรณ์ (ไปต่อ): ${e.message}`);
      }

      // รอจนปุ่มพร้อมใช้งาน (ไม่นับปุ่มที่ยัง disabled ระหว่างนับถอยหลัง)
      const ready = await waitFor(async () => {
        if (finalKey) return true;
        const st = await readPage(page);
        return (
          st.buttons.some((b) => !b.disabled) ||
          st.text.includes('Successfully whitelisted') ||
          st.text.includes('minutes left')
        );
      }, READY_TIMEOUT_MS);

      if (!ready) log('หน้าเว็บโหลดช้ากว่าปกติ กำลังไปต่อ...');

      await dumpPage(page, `step${stepCount}-loaded`, log);
      await debugShot(page, `step${stepCount}-loaded`);

      // ลองคลิกหลายครั้ง เพราะปุ่มจะกดได้หลังนับถอยหลังเสร็จ
      let advanced = false;
      for (let attempt = 0; attempt < 8 && !finalKey && !advanced; attempt++) {
        const st = await readPage(page);

        if (st.text.includes('Successfully whitelisted') || st.text.includes('minutes left')) break;

        // 1) ปุ่ม Continue หน้าสุดท้าย (หน้า Create your key) — ต้องเป็น "Continue" เท่านั้น
        //    ห้ามใช้ includes('continue') เพราะจะไปโดนปุ่ม "or continue with linkvertise"
        const continueBtn = st.buttons.find((b) => !b.disabled && /^continue$/i.test(b.text));
        if (continueBtn) {
          log('พบปุ่ม Continue หน้าสุดท้าย กำลังคลิก...');
          await page.evaluate(() => {
            const btn = Array.from(document.querySelectorAll('button')).find(
              (b) => /^continue$/i.test(b.innerText.trim())
            );
            if (btn) btn.click();
          });

          await waitFor(async () => {
            if (finalKey) return true;
            const s = await readPage(page);
            return s.text.includes('Successfully whitelisted') || s.text.includes('minutes left');
          }, READY_TIMEOUT_MS);

          await dumpPage(page, `step${stepCount}-afterContinue`, log);
          await debugShot(page, `step${stepCount}-afterContinue`);

          advanced = true;
          break;
        }

        // 2) ปุ่มเลือกผ่านทาง Linkvertise
        //    ⚠️ ต้องเลือกจากข้อความ "linkvertise" เท่านั้น ห้ามเลือกจาก class (bg-primary)
        //    เพราะตอนนี้มีปุ่ม "Lootlabs (1 step)" ที่ใช้ class เดียวกัน
        const lvBtn = st.buttons.find(
          (b) => !b.disabled && b.text.toLowerCase().includes('linkvertise')
        );
        if (lvBtn) {
          log('กำลังคลิกเลือกผ่านทาง Linkvertise...');
          await page.evaluate(() => {
            const btn = Array.from(document.querySelectorAll('button')).find(
              (b) => b.innerText.toLowerCase().includes('linkvertise')
            );
            if (btn) btn.click();
          });

          // รอ Linkvertise เด้ง (แท็บเดิมหรือแท็บใหม่)
          await waitFor(async () => {
            if (finalKey) return true;
            return (await findLinkvertise()) !== null;
          }, REDIRECT_TIMEOUT_MS);

          const lvUrl = await findLinkvertise();
          if (lvUrl) {
            log('พบ Linkvertise URL กำลังถอดรหัส Bypass...');
            const rParam = new URL(lvUrl).searchParams.get('r');
            const nextUrl = rParam ? decodeBase64(rParam) : null;
            if (nextUrl && nextUrl.startsWith('http')) {
              log('ถอดรหัสด่านถัดไปสำเร็จ!');
              currentUrl = nextUrl;
              advanced = true;
            }
            break; // เจอ Linkvertise แล้ว ออกไปเริ่มขั้นตอนใหม่
          }

          // ยังไม่เด้ง (อาจติดนับถอยหลัง) ลองคลิกใหม่
          await sleep(SETTLE_MS);
          continue;
        }

        // ยังไม่มีปุ่มที่กดได้ (รอปุ่มนับถอยหลัง) ลองใหม่
        await sleep(SETTLE_MS);
      }

      if (finalKey) break;
      if (!advanced) log('ไม่พบปุ่มที่คลิกได้ในขั้นตอนนี้ กำลังไปต่อ...');
    }

    if (!finalKey) {
      throw new Error('ไม่พบ KEY (หน้าเว็บอาจเปลี่ยนรูปแบบ หรือโดนบล็อก)');
    }
    return finalKey;
  })();

  try {
    return await Promise.race([work, timeoutPromise]);
  } finally {
    finished = true;
    if (timer) clearTimeout(timer);

    // ปิด context ของงานนี้ (คืน RAM ของแท็บ) แต่ไม่แตะ Chrome ตัวกลาง
    if (context) {
      try {
        await context.close();
      } catch (e) {}
    }

    if (timedOut) {
      // งานค้าง: ปิด Chrome ทิ้งเพื่อความสะอาด แล้วเปิดใหม่ในงานถัดไป
      await closeBrowser();
    } else {
      await recycleIfNeeded();
    }

    // ลดงานที่กำลังรัน แล้วนัดปิด Chrome ถ้าไม่มีงานต่อ
    activeJobs--;
    if (activeJobs <= 0) scheduleIdleClose();
  }
}

module.exports = { solvePlatoboost, isValidUrl, closeBrowser, RECYCLE_AFTER, IDLE_CLOSE_MS };
