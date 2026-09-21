import { createServer } from 'node:http'
import { createGateway } from '@ai-sdk/gateway'
import { experimental_evaluate } from 'ai'

let captured = null
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (d) => { body += d })
  req.on('end', () => {
    captured = { method: req.method, url: req.url, headers: Object.fromEntries(Object.entries(req.headers).map(([k,v])=>[k, /authorization|api-key/i.test(k)?'REDACTED':v])), body: JSON.parse(body) }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      answers: {
        difficulty: { type: 'score', score: 2.31, probabilities: { '0': 0.02, '1': 0.11, '2': 0.41, '3': 0.46 } },
        kind: { type: 'choice', choice: 'coding', probabilities: { coding: 0.96, research: 0.04 } },
        costly_mistake: { type: 'boolean', probability: 0.78 },
      },
      usage: { inputTokens: 412, outputTokens: 37 },
    }))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const gateway = createGateway({ apiKey: 'test-key-not-real', baseURL: `http://127.0.0.1:${port}/v1` })
try {
  const result = await experimental_evaluate({
    model: gateway.evaluationModel('typesafe-ai/jev'),
    state: { user_turn: 'Design a zero-downtime migration.', context: { tokens: 1595 } },
    questions: {
      difficulty: { type: 'score', instructions: 'How demanding?', criteria: ['trivial', 'simple', 'routine', 'substantial'] },
      kind: { type: 'choice', instructions: 'What kind of work?', criteria: { coding: 'software', research: 'investigation' } },
      costly_mistake: { type: 'boolean', instructions: 'Costly if wrong?', criteria: { false: 'not costly', true: 'costly' } },
    },
  })
  console.log('=== REQUEST ACTUALLY SENT (gateway evaluationModel)')
  console.log(JSON.stringify(captured, null, 1))
  console.log('=== RESULT')
  console.log(JSON.stringify(result.answers, null, 1))
} catch (e) {
  console.log('ERR', String(e.message).slice(0, 300))
  console.log('captured:', JSON.stringify(captured))
}
server.close()
