import path from 'node:path';
import { createApp } from './app.js';
import { TcgClient } from './tcg.js';

const port = Number(process.env.PORT ?? 3000);
const dataDir = path.resolve(process.env.DATA_DIR ?? 'data');
const tcg = new TcgClient({ baseUrl: process.env.TCGDEX_URL });

const app = createApp({ dataDir, tcg });
app.listen(port, () => {
  console.log(`Pokédex collection running at http://localhost:${port}`);
  console.log(`Collection data is stored in ${dataDir}`);
});
