interface DataPoint {
  timestamp: Date;
}
class Flight {
  data: DataPoint[] = [];
  rawstr: string;
  constructor(rawstr: string) {
    this.rawstr = rawstr;
  }
  init = async () => {
    this.data = await JSON.parse(this.rawstr).map((entry: any) => ({
      ...entry,
      timestamp: new Date(entry.timestamp),
    }));
  };
  length = () => this.data.length;
  first = () => this.data[0];
  last = () => this.data[this.data.length - 1];
  duration = () =>
    this.last().timestamp.getTime() - this.first().timestamp.getTime();
}

export default { Flight };
