import { Flight } from '../src/index';
import * as fs from 'fs';
//import * as process from 'process';

//console.log(process.cwd());
const start = async () => {
  const data = fs.readFileSync('toulouse.json', 'utf8');
  const f = new Flight(data);
  await f.init();
  console.log(f.length());
  console.log(f.duration());
};

start();
