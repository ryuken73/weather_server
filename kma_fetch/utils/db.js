const sql = require('mssql');
const env = require('../config/env');

const {
  MSSQL_HOST,
  MSSQL_USER,
  MSSQL_PASSWD,
  MSSQL_DB
} = env;

const pool = new sql.ConnectionPool({
  user: MSSQL_USER, 
  password: MSSQL_PASSWD,
  server: MSSQL_HOST,
  database: MSSQL_DB,
  options: {
    encrypt: false
  }
})

const connect = () => {
  return new Promise((resolve, reject) => {
    console.log('connect to db...')
    pool.connect((err) => {
      if (err) {
        console.error('Error connecting to database:', err);
        reject(err)
      }
      console.log('Connected to database!');
      resolve(pool)
    });
  })
}

const sqls = {
  queryAwsMin: `
    SELECT  ACODE.Name3 AS STN_NAME, AWS.STN_ID, AWS.TM, AWS.LAT, AWS.LON, AWS.HT, AWS.WD, AWS.WS, 
      AWS.TA, AWS.HM, AWS.PA, AWS.PS, AWS.RN_YN, AWS.RN_1HR, NULL AS RN_6HR, NULL AS RN_12HR, 
      AWS.RN_DAY AS RN_24HR, NULL AS RN_48HR, AWS.RN_15M, AWS.RN_60M, AWS.WD_INS, 
      AWS.WS_INS
    FROM     dbo.wx_AWS_MIN AS AWS LEFT OUTER JOIN
      dbo.wx_AWS_Area AS ACODE ON AWS.STN_ID = ACODE.Code3 and ACODE.State = 1
    WHERE  TM=@tm
  `
}

module.exports = {
  connect,
  sqls
}