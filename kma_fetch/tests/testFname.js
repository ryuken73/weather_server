const file = require('../utils/file');
const sampleData = Buffer.from('test');
const utcDate = new Date('2025-03-19T06:00:00Z');
file.saveNcFile(sampleData, 'gk2a_ami_le1b_ir105_ea020lc_202503190600.nc', utcDate);