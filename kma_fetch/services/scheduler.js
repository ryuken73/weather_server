const schedule = require('node-schedule');

const intervals = {
  '1min': '* * * * *', // 매분
  '2min': '*/2 * * * *', // 매2분
  '5min': '4-59/5 * * * *', // 매5분
  '10min': '5-55/10 * * * *', // 10분마다
  '1hour': '0 * * * *', // 매시
  '1day': '0 0 * * *', // 매일 00:00
  // AWS hourly stat (awsh) — 기본 매시 12분; resolveInterval에서 분 override
  hourly_stat: '12 * * * *',
  kim_custom: '10,20 * * * *', // KIM 전용: 매일 00, 06, 12, 18시 10분
  kim_prs_custom: '15,25 * * * *', // KIM 전용
  kim_text_custom: '15,25 * * * *' // KIM_TXT 전용
};

/**
 * @param {string} interval - named key or raw 5-field cron
 * @param {NodeJS.ProcessEnv} [env]
 */
function resolveInterval(interval, env = process.env) {
  if (interval === 'hourly_stat') {
    const raw = Number(env.AWS_HOURLY_STAT_MINUTE ?? 12);
    const minute = Number.isFinite(raw) ? Math.min(59, Math.max(0, Math.floor(raw))) : 12;
    return `${minute} * * * *`;
  }
  if (intervals[interval]) return intervals[interval];
  // allow raw cron (5 fields)
  if (typeof interval === 'string' && interval.trim().split(/\s+/).length === 5) {
    return interval.trim();
  }
  return null;
}

/**
 * 주기적으로 태스크를 스케줄링
 * @param {string} taskName - 태스크 고유 이름
 * @param {string} interval - "1min", "10min", "1hour", "1day", "hourly_stat", or cron
 * @param {Function} task - 실행할 함수
 */
function scheduleTask(taskName, interval, task) {
  const cronExpr = resolveInterval(interval);
  if (!cronExpr) {
    throw new Error(`Invalid interval: ${interval}`);
  }

  // 이전 job이 끝나기 전에 다음 tick이 오면 중첩 실행되며 FD 누수를 가속할 수 있음
  let running = false;

  schedule.scheduleJob(taskName, cronExpr, () => {
    if (running) {
      console.log(`Skipping task (still running): ${taskName}`);
      return;
    }
    running = true;
    console.log(`Running task: ${taskName}`);
    Promise.resolve()
      .then(task)
      .catch((error) => {
        console.error(`Scheduled task failed: ${taskName}`, error);
      })
      .finally(() => {
        running = false;
      });
  });
  console.log(`Scheduled task: ${taskName} with interval ${interval} (${cronExpr})`);
}

module.exports = {
  scheduleTask,
  resolveInterval,
  intervals
};
