const path = require('path');
const express = require('express');
const { solvePlatoboost, isValidUrl, closeBrowser, RECYCLE_AFTER, IDLE_CLOSE_MS } = require('./solver');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== ตั้งค่า reverse proxy =====
// อยู่หลัง nginx → อ่าน IP จริงของลูกค้าจาก X-Forwarded-For (ไม่งั้นทุกคนจะนับเป็น 127.0.0.1)
// ตั้ง TRUST_PROXY=0 ถ้าเปิดพอร์ตนี้ให้เข้าถึงโดยตรง (ไม่ผ่าน proxy)
const TRUST_PROXY = process.env.TRUST_PROXY ?? '1';
if (TRUST_PROXY !== '0' && TRUST_PROXY !== 'false') {
  app.set('trust proxy', /^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : TRUST_PROXY);
}

// ===== ตั้งค่า =====
const CONCURRENCY = 1;              // รันทีละงาน (ปลอดภัยกับ RAM น้อย)
const JOB_TIMEOUT_MS = 90 * 1000;   // งานละไม่เกิน 90 วินาที
const JOB_TTL_MS = 10 * 60 * 1000;  // เก็บผลไว้ 10 นาทีแล้วลบ
const ONLINE_WINDOW_MS = 5 * 60 * 1000; // นับ "ออนไลน์" ถ้าใช้งานภายใน 5 นาที

// ===== โครงสร้างคิว =====
const jobs = new Map();   // id -> job
const queue = [];         // รอทำงาน
let running = 0;          // จำนวนงานที่กำลังรัน

// ===== สถิติ =====
const stats = { total: 0, success: 0, failed: 0 };
const activeUsers = new Map(); // ip -> lastSeen (สำหรับนับออนไลน์)
const knownUsers = new Set();  // ip ทั้งหมดที่เคยใช้

app.use(express.json());
app.use(express.static(__dirname));

// นับผู้ใช้งานจากทุก request
app.use((req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  activeUsers.set(ip, Date.now());
  knownUsers.add(ip);
  next();
});

// ล้างผู้ใช้ที่หลุดออนไลน์เป็นระยะ
setInterval(() => {
  const cutoff = Date.now() - ONLINE_WINDOW_MS;
  for (const [ip, t] of activeUsers) {
    if (t < cutoff) activeUsers.delete(ip);
  }
}, 30000);

function publicJob(job) {
  const queuePos = job.status === 'queued' ? queue.indexOf(job) + 1 : 0;
  return {
    id: job.id,
    status: job.status,          // queued | running | done | error
    queuePosition: queuePos,     // ลำดับในคิว (0 = ไม่ได้รอ)
    waiting: queuePos > 0 ? queuePos - 1 : 0, // มีคนรอข้างหน้ากี่คน
    key: job.key,
    error: job.error,
    createdAt: job.createdAt
  };
}

function enqueue(url) {
  const id = 'job_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const job = {
    id,
    url,
    status: 'queued',
    key: null,
    error: null,
    createdAt: Date.now()
  };
  jobs.set(id, job);
  queue.push(job);
  stats.total++;
  console.log(`📥 เข้าคิว: ${id} (คิวทั้งหมด ${queue.length})`);
  pump();
  return job;
}

function pump() {
  while (running < CONCURRENCY && queue.length > 0) {
    const job = queue.shift();
    runJob(job);
  }
}

async function runJob(job) {
  running++;
  job.status = 'running';
  console.log(`🚀 เริ่มงาน: ${job.id} (กำลังรัน ${running} งาน)`);

  try {
    const key = await solvePlatoboost(job.url, {
      timeoutMs: JOB_TIMEOUT_MS,
      onLog: (m) => console.log(`   [${job.id}] ${m}`)
    });
    job.key = key;
    job.status = 'done';
    stats.success++;
    console.log(`✅ สำเร็จ: ${job.id}`);
  } catch (err) {
    job.error = err.message || 'เกิดข้อผิดพลาดไม่ทราบสาเหตุ';
    job.status = 'error';
    stats.failed++;
    console.log(`❌ ล้มเหลว: ${job.id} -> ${job.error}`);
  } finally {
    running--;
    pump();
    setTimeout(() => {
      jobs.delete(job.id);
    }, JOB_TTL_MS);
  }
}

// ===== API =====

// สร้างงานใหม่
app.post('/api/key', (req, res) => {
  const url = (req.body && req.body.url ? String(req.body.url) : '').trim();

  if (!url) {
    return res.status(400).json({ error: 'กรุณาใส่ URL' });
  }
  if (!isValidUrl(url)) {
    return res.status(400).json({ error: 'URL ไม่ถูกต้อง (ต้องเป็นลิงก์ Platoboost / Platorelay)' });
  }

  const job = enqueue(url);
  res.json(publicJob(job));
});

// ดูสถานะงาน
app.get('/api/key/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'ไม่พบงานนี้ (อาจหมดอายุหรือเสร็จแล้ว)' });
  }
  res.json(publicJob(job));
});

// สถิติรวม
app.get('/api/stats', (req, res) => {
  res.json({
    total: stats.total,          // งานทั้งหมดที่เคยรับ
    success: stats.success,      // ดึงสำเร็จ
    failed: stats.failed,        // ล้มเหลว
    queued: queue.length,        // กำลังรอในคิว
    running: running,            // กำลังทำงาน
    online: activeUsers.size,    // ออนไลน์ตอนนี้
    users: knownUsers.size       // ผู้ใช้ทั้งหมดที่เคยเข้า
  });
});

app.listen(PORT, () => {
  console.log('========================================');
  console.log(`🌐 KEY Auto พร้อมใช้งาน: http://localhost:${PORT}`);
  console.log(`⚙️  รันพร้อมกัน: ${CONCURRENCY} งาน | timeout: ${JOB_TIMEOUT_MS / 1000} วิ`);
  console.log(`♻️  ใช้ Chrome ซ้ำ และรีไซเคิลทุก ${RECYCLE_AFTER} งาน`);
  console.log(`💤 ปิด Chrome อัตโนมัติเมื่อว่าง ${Math.round(IDLE_CLOSE_MS / 1000)} วิ`);
  console.log('========================================');
});

// ปิด Chrome ให้เรียบร้อยตอนกด Ctrl+C / ระบบสั่งปิด
async function shutdown() {
  console.log('\n⏹️  กำลังปิดระบบ...');
  await closeBrowser();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
