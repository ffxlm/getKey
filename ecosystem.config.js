// ===== pm2 config สำหรับ deploy บน VPS =====
// ใช้งาน:
//   pm2 start ecosystem.config.js
//   pm2 save
//   pm2 logs getkey
//
// หมายเหตุ: ต้องรันแบบ fork + instances 1 เท่านั้น
// เพราะคิวงานเก็บใน memory (ถ้าใช้ cluster หลาย process คิวจะแยกกัน)
module.exports = {
  apps: [
    {
      name: 'getkey',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '600M',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        // ตำแหน่ง Chrome บน VPS (google-chrome-stable)
        CHROME_PATH: '/usr/bin/google-chrome',
        // อยู่หลัง nginx → เปิด trust proxy
        TRUST_PROXY: '1',
        // รีไซเคิล Chrome ทุกกี่งาน
        RECYCLE_AFTER: '40',
        // ปิด Chrome อัตโนมัติเมื่อว่าง (มิลลิวินาที) — 5 นาที
        IDLE_CLOSE_MS: '300000'
      }
    }
  ]
};
