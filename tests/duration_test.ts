import { Flight } from '../src/core';
//import * as fs from 'fs';
//import * as process from 'process';

//console.log(process.cwd());
const start = async () => {
  const f = await Flight.from_url('http://127.0.0.1:5500/toulouse.json.gz');
  console.log(f.length());
  console.log(f.duration());
};

start();
