import { spawn } from 'node:child_process'
import {
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { resolve, join, sep } from 'node:path'

const root = resolve('.qa')
const command = process.argv.at(2) ?? 'start'
const argument = process.argv.at(3)
const marker = 'spendle-qa-v2'
function ownedRun(value: string | undefined) {
  if (!value) throw new Error('Supply the run directory printed by qa:start.')
  const path = realpathSync(value)
  if (
    !path.startsWith(`${realpathSync(root)}${sep}`) ||
    JSON.parse(readFileSync(join(path, 'run.json'), 'utf8')).kind !== marker
  ) {
    throw new Error('This directory is not an owned QA run.')
  }
  return path
}

if (command === 'inspect') {
  // The QA API keeps its data in memory: inspect it over HTTP while it runs.
  const { apiUrl } = JSON.parse(
    readFileSync(join(ownedRun(argument), 'run.json'), 'utf8'),
  )
  const read = async (path: string) => {
    const response = await fetch(`${apiUrl}/api/v2${path}`)
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`)
    return response.json()
  }
  console.log(
    JSON.stringify(
      {
        accounts: await read('/accounts'),
        entries: await read('/entries?limit=100'),
        imports: await read('/imports'),
      },
      null,
      2,
    ),
  )
} else if (command === 'clean') {
  const directory = ownedRun(argument)
  // Cleanup is explicit and only for a stopped run. Probe the recorded PID first.
  const metadata = JSON.parse(readFileSync(join(directory, 'run.json'), 'utf8'))
  let running = false
  try {
    process.kill(metadata.pid, 0)
    running = true
  } catch {
    /* Process exited. */
  }
  if (running) throw new Error('Stop the QA server before cleaning its run.')
  rmSync(directory, { recursive: true })
  console.log(`Removed ${directory}`)
} else if (command === 'start') {
  const port = Number(argument ?? 3100)
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('Usage: pnpm qa:start [port]')
  mkdirSync(root, { recursive: true })
  const directory = mkdtempSync(join(root, 'run-'))
  const url = `http://127.0.0.1:${port}`
  // The V2 API runs beside the app, in memory, with synthetic data and a fake Pluggy.
  const apiPort = port + 1200
  const apiUrl = `http://127.0.0.1:${apiPort}`
  const month = new Date().toISOString().slice(0, 7)
  const date = `${month}-01`
  const ofx = (closing: string, suffix: string) =>
    `OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\nSECURITY:NONE\nENCODING:USASCII\nCHARSET:1252\nCOMPRESSION:NONE\nOLDFILEUID:NONE\nNEWFILEUID:NONE\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL</CURDEF><BANKTRANLIST><DTSTART>${month.replace('-', '')}01</DTSTART><DTEND>${month.replace('-', '')}02</DTEND><STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>${month.replace('-', '')}01120000[-3:BRT]</DTPOSTED><TRNAMT>1000.00</TRNAMT><FITID>qa-income-${suffix}</FITID><NAME>Receita QA</NAME></STMTTRN><STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>${month.replace('-', '')}02120000[-3:BRT]</DTPOSTED><TRNAMT>-100.00</TRNAMT><FITID>qa-expense-${suffix}</FITID><NAME>Mercado QA</NAME></STMTTRN></BANKTRANLIST><LEDGERBAL><BALAMT>${closing}</BALAMT><DTASOF>${month.replace('-', '')}02</DTASOF></LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`
  writeFileSync(join(directory, 'balanced.ofx'), ofx('900.00', 'balanced'))
  writeFileSync(join(directory, 'unbalanced.ofx'), ofx('999.00', 'unbalanced'))
  // 121 expenses of R$ 1,00 on the first day of the month, for V2 pagination checks.
  const compact = month.replace('-', '')
  writeFileSync(
    join(directory, 'volume-121.ofx'),
    `OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\nSECURITY:NONE\nENCODING:USASCII\nCHARSET:1252\nCOMPRESSION:NONE\nOLDFILEUID:NONE\nNEWFILEUID:NONE\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL</CURDEF><BANKTRANLIST><DTSTART>${compact}01</DTSTART><DTEND>${compact}01</DTEND>${Array.from(
      { length: 121 },
      (_, index) =>
        `<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>${compact}01120000[-3:BRT]</DTPOSTED><TRNAMT>-1.00</TRNAMT><FITID>qa-volume-${index}</FITID><NAME>Despesa QA ${index}</NAME></STMTTRN>`,
    ).join(
      '',
    )}</BANKTRANLIST><LEDGERBAL><BALAMT>-121.00</BALAMT><DTASOF>${compact}01</DTASOF></LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`,
  )
  writeFileSync(
    join(directory, 'run.json'),
    JSON.stringify(
      { kind: marker, pid: process.pid, url, apiUrl, directory, date },
      null,
      2,
    ),
  )
  console.log(
    JSON.stringify(
      {
        url,
        apiUrl,
        directory,
        date,
      },
      null,
      2,
    ),
  )
  const log = createWriteStream(join(directory, 'server.log'))
  const apiLog = createWriteStream(join(directory, 'server-v2.log'))
  const api = spawn(
    process.execPath,
    [resolve('packages/server/src/testing/QaServer.ts')],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, SPENDLE_SERVER_PORT: String(apiPort) },
    },
  )
  api.stdout.pipe(apiLog)
  api.stderr.pipe(apiLog)
  const child = spawn(
    process.execPath,
    [
      resolve('node_modules/vite/bin/vite.js'),
      'dev',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort',
    ],
    {
      stdio: ['inherit', 'pipe', 'pipe'],
      env: {
        ...process.env,
        SPENDLE_API_URL: apiUrl,
        SPENDLE_API_TOKEN: '',
        // The fake Pluggy issues fake tokens: open the simulated widget instead.
        SPENDLE_PLUGGY_CONNECT: 'simulated',
      },
    },
  )
  child.stdout.on('data', (chunk) => {
    process.stdout.write(chunk)
    log.write(chunk)
  })
  child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk)
    log.write(chunk)
  })
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.on(signal, () => {
      child.kill(signal)
      api.kill(signal)
    })
  child.on('exit', (code) => {
    api.kill('SIGTERM')
    log.end()
    process.exitCode = code ?? 0
  })
} else {
  throw new Error('Expected start, inspect or clean.')
}
