import * as d3 from 'd3';

type timelike = string | Date;

const make_date = function (timestamp: timelike): Date {
  let result =
    timestamp instanceof Date
      ? timestamp
      : d3.utcParse('%Y-%m-%d %H:%M:%S')(timestamp);

  if (result === null) {
    result = new Date();
  }
  return result;
};

export { make_date, timelike };
