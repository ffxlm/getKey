const puppeteer = require('puppeteer-core');

/**
 * Platoboost / Delta Key Auto Retriever
 * Usage: node getkey.js "<URL>"
 */

function decodeBase64(str) {
  try {
    return Buffer.from(decodeURIComponent(str), 'base64').toString('utf-8');
  } catch (e) {
    return null;
  }
}

async function solvePlatoboost(startUrl) {
  if (!startUrl || !startUrl.includes('platorelay.com') && !startUrl.includes('platoboost')) {
    console.error('❌ กรุณาใส่ URL ของ Platoboost ให้ถูกต้อง');
    console.error('ตัวอย่าง: node getkey.js "https://auth.platorelay.com/a?d=..."');
    process.exit(1);
  }

  console.log('🚀 เริ่มต้นระบบดึง Key อัตโนมัติ...');
  console.log('🔗 URL เริ่มต้น:', startUrl);

  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled'
    ]
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

    let finalKey = null;

    // ดักฟัง Response เพื่อจับ Key ทันทีที่ปล่อยออกมา
    page.on('response', async res => {
      if (res.url().includes('/api/session/status')) {
        try {
          const json = await res.json();
          if (json && json.data && json.data.key && json.data.key !== 'KEY_NOT_FOUND') {
            finalKey = json.data.key;
          }
        } catch (e) {}
      }
    });

    let currentUrl = startUrl;
    let maxSteps = 10;
    let stepCount = 0;

    while (stepCount < maxSteps) {
      stepCount++;
      console.log(`\n📌 [ขั้นตอนที่ ${stepCount}] กำลังเปิดหน้าเว็บ: ${currentUrl.slice(0, 70)}...`);
      await page.goto(currentUrl, { waitUntil: 'networkidle2' });

      // รอข้อมูลหน้าเว็บและปุ่มโหลด
      await new Promise(r => setTimeout(r, 3500));

      const pageState = await page.evaluate(() => {
        const text = document.body.innerText;
        const buttons = Array.from(document.querySelectorAll('button')).map(b => ({
          text: b.innerText.trim(),
          disabled: b.disabled
        }));
        return { text, buttons };
      });

      // ตรวจสอบว่าสำเร็จแล้วหรือยัง
      if (finalKey || pageState.text.includes('Successfully whitelisted') || pageState.text.includes('minutes left')) {
        break;
      }

      // กรณีถึงหน้า Create your key / Whitelist
      const hasContinue = pageState.buttons.find(b => b.text.toLowerCase().includes('continue'));
      if (hasContinue) {
        console.log('✨ พบปุ่ม Continue หน้าสุดท้าย กำลังคลิก...');
        await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button'));
          const btn = btns.find(b => b.innerText.toLowerCase().includes('continue'));
          if (btn) btn.click();
        });

        await new Promise(r => setTimeout(r, 4000));
        if (finalKey) break;
      }

      // ด่านทั่วไป (Checkpoint 1, 2)
      // เลือก Linkvertise เพื่อแกะ Base64 Bypass
      console.log('⏳ กำลังคลิกเลือกผ่านทาง Linkvertise...');
      
      let redirectUrl = null;
      const targetCreatedPromise = new Promise(resolve => {
        const onTarget = async target => {
          if (target.type() === 'page') {
            const p = await target.page();
            if (p) {
              const u = p.url();
              resolve(u);
            }
          }
        };
        browser.once('targetcreated', onTarget);
      });

      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const btn = btns.find(b => b.innerText.toLowerCase().includes('linkvertise') || b.className.includes('bg-primary'));
        if (btn) btn.click();
      });

      // รอการ Redirect ในหน้าเดิม หรือแท็บใหม่
      await new Promise(r => setTimeout(r, 4000));

      const candidateUrl = page.url();
      let lvUrl = candidateUrl.includes('linkvertise.com') ? candidateUrl : null;

      if (!lvUrl) {
        // เผื่อเด้งแท็บใหม่
        const pages = await browser.pages();
        for (const p of pages) {
          if (p.url().includes('linkvertise.com')) {
            lvUrl = p.url();
            break;
          }
        }
      }

      if (lvUrl) {
        console.log('🔍 พบ Linkvertise URL กำลังถอดรหัส Bypass...');
        const urlObj = new URL(lvUrl);
        const rParam = urlObj.searchParams.get('r');
        if (rParam) {
          const nextUrl = decodeBase64(rParam);
          if (nextUrl && nextUrl.startsWith('http')) {
            console.log('✅ ถอดรหัสด่านถัดไปสำเร็จ!');
            currentUrl = nextUrl;
            continue;
          }
        }
      }

      // ถ้าไม่พบการ redirect หรือดึง key สำเร็จแล้ว
      if (finalKey) break;
    }

    if (finalKey) {
      console.log('\n========================================');
      console.log('🎉🎉 ได้รับ KEY สำเร็จเรียบร้อย! 🎉🎉');
      console.log('🔑 KEY:', finalKey);
      console.log('========================================\n');
    } else {
      console.log('\n⚠️ ไม่พบ Key กรุณาตรวจสอบสถานะหน้าเว็บ');
      const text = await page.evaluate(() => document.body.innerText);
      console.log('ข้อความบนหน้า:', text.slice(0, 300));
    }

  } catch (err) {
    console.error('❌ เกิดข้อผิดพลาด:', err.message);
  } finally {
    await browser.close();
  }
}

const inputUrl = process.argv[2];
solvePlatoboost(inputUrl);
