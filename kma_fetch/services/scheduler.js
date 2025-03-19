const schedule = require('node-schedule');

const intervals = {
  '1min': '* * * * *',        // 매분
  '10min': '1-51/10 * * * *',    // 10분마다
  '1hour': '0 * * * *',       // 매시
  '1day': '0 0 * * *',        // 매일 00:00
};

/**
 * 주기적으로 태스크를 스케줄링
 * @param {string} taskName - 태스크 고유 이름
 * @param {string} interval - "1min", "10min", "1hour", "1day"
 * @param {Function} task - 실행할 함수
 */
function scheduleTask(taskName, interval, task) {
  if (!intervals[interval]) {
    throw new Error(`Invalid interval: ${interval}`);
  }

  schedule.scheduleJob(taskName, intervals[interval], () => {
    console.log(`Running task: ${taskName}`);
    task();
  });
  console.log(`Scheduled task: ${taskName} with interval ${interval}`);
}

module.exports = {
  scheduleTask,
};