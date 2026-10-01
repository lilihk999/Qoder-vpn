'use strict';
// 被 test/tmp.test.js 以子进程方式跑：故意不调 sweepTmp，用来证明 exit 钩子自己会扫。
const fs = require('node:fs');
const path = require('node:path');
const T = require('../tmp');

const dir = T.mkTmp('leak');
fs.writeFileSync(path.join(dir, 'payload.txt'), '留下的不是空目录，是整份沙箱配置');
process.stdout.write(JSON.stringify({ dir, existedWhileRunning: fs.existsSync(dir) }));
