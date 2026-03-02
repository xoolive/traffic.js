import { Flight } from '../core/flight.js';
import { Traffic } from '../core/traffic.js';

export const belevingsvlucht = () => Flight.fromSample('belevingsvlucht');
export const quickstart = () => Traffic.fromSample('quickstart', 'collections');

export const sample = new Proxy(
  {},
  {
    get(_target: object, prop: string | symbol): unknown {
      if (prop === 'belevingsvlucht') {
        return belevingsvlucht();
      }
      if (prop === 'quickstart') {
        return quickstart();
      }
      return undefined;
    },
  }
) as {
  belevingsvlucht: ReturnType<typeof belevingsvlucht>;
  quickstart: ReturnType<typeof quickstart>;
};
