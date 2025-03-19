const path = require('path');
BASE_ADDR = 'https://apihub.kma.go.kr/api/typ05/api/GK2A/'
const setupAPI = (API_KEY) => {
  return {
    'le1b': { //기본자료
      dataList: async (dataType, dataArea, sDate, eDate) => {
        const reqUrl = path.join(BASE_ADDR, dataType, dataArea, 'dataList')
        const withParam = `${reqUrl}?sDate=${sDate}&eDate=${eDate}&format=${json}&authKey=${AUTH_KEY}`
      }
    } 
  }
}

module.exports = setupAPI
