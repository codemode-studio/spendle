import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { config } from 'dotenv'
import { defineConfig } from 'drizzle-kit'

config({ path: ['.env.local', '.env'] })

const databaseUrl = process.env.DATABASE_URL || './data/financas.db'
mkdirSync(dirname(resolve(process.cwd(), databaseUrl.replace(/^file:/, ''))), {
  recursive: true,
})

export default defineConfig({
  out: './drizzle',
  schema: './src/db/schema.ts',
  dialect: 'sqlite',
  dbCredentials: {
    url: databaseUrl,
  },
})
