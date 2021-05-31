import { tidy, mutate, arrange, desc } from '@tidyjs/tidy';

const data = [
  { a: 1, b: 10 },
  { a: 3, b: 12 },
  { a: 2, b: 10 },
];

const results = tidy(
  data,
  mutate({ ab: (d) => d.a * d.b }),
  arrange(desc('ab'))
);

console.log(results);
