import { createServer } from 'node:http'
import { createTypeSafeAi } from '@ai-sdk/typesafe-ai'
import { experimental_evaluate } from 'ai'

let captured = null
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (d) => { body += d })
  req.on('end', () => {
    captured = { method: req.method, url: req.url, headers: { ...req.headers, authorization: 'REDACTED' }, body: JSON.parse(body) }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      answers: {
        difficulty: { type: 'score', score: 2.31, probabilities: { '0': 0.02, '1': 0.11, '2': 0.41, '3': 0.46 } },
        kind: { type: 'choice', choice: 'coding', probabilities: { coding: 0.91, writing: 0.03, research: 0.04, general: 0.02 } },
        costly_mistake: { type: 'noul', noul: 0.78 },
      },
      rounding: { probabilityDecimals: 2, scoreDecimals: 2 },
      usage: { inputTokens: 412, outputTokens: 37 },
      providerMetadata: { typesafe: { confidence: { difficulty: 0.93, kind: 0.88, costly_mistake: 0.81 } } },
    }))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const provider = createTypeSafeAi({ apiKey: 'test-key-not-real', baseURL: `http://127.0.0.1:${port}/v1` })
const result = await experimental_evaluate({
  model: provider.evaluationModel('typesafe-ai/jev'),
  state: { user_turn: 'Design a zero-downtime migration.', context: { tokens: 1595 } },
  questions: {
    difficulty: { type: 'score', instructions: 'How demanding is it to complete this turn well?', criteria: ['trivial', 'simple', 'routine', 'substantial'] },
    kind: { type: 'choice', instructions: 'What kind of work is this turn mainly?', criteria: { coding: 'software', writing: 'prose', research: 'investigation', general: 'other' } },
    costly_mistake: { type: 'boolean', instructions: 'A wrong answer here would be costly', criteria: { false: 'not costly', true: 'costly' } },
  },
})
server.close()
console.log('=== REQUEST ACTUALLY SENT')
console.log(JSON.stringify(captured, null, 1))
console.log('=== NORMALIZED RESULT')
console.log(JSON.stringify({ answers: result.answers, rounding: result.rounding, usage: result.usage, confidence: result.providerMetadata?.typesafe?.confidence }, null, 1))
