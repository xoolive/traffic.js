import fetch from 'cross-fetch';
import pako from 'pako';

/**
 * Defines the usual types for each feature in a data frame
 * */
interface DataPoint {
  timestamp: Date;
  latitude: number;
  longitude: number;
  altitude: number;
  icao24: string;
  callsign: string;
}

/**
 *  Flight wraps around DataPoint[]
 *  */
class Flight {
  data: DataPoint[] = [];
  constructor(data: DataPoint[]) {
    this.data = data.map((entry: any) => ({
      ...entry,
      timestamp: new Date(entry.timestamp),
    }));
  }
  static from_url = async (url: string) => {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(response.statusText);
    }
    const buf = await response.arrayBuffer();
    const array = new Uint8Array(buf);
    let data: DataPoint[];
    if (array[0] === 0x1f && array[1] === 0x8b) {
      // GZip file header
      data = JSON.parse(pako.inflate(array, { to: 'string' }));
    } else {
      const decoder = new TextDecoder('utf-8');
      const s = decoder.decode(new Uint8Array(buf));
      data = JSON.parse(s);
    }
    return new Flight(data);
  };
  length = () => this.data.length;
  start = () => this.data[0].timestamp;
  stop = () => this.data[this.data.length - 1].timestamp;
  at = () => this.data[this.data.length - 1];
  duration = () => (this.stop().getTime() - this.start().getTime()) / 1000;
}

/** exports */
export { Flight };
