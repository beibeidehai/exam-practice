const http = require('http');
const fs = require('fs');
const path = require('path');

const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
const PORT = process.env.PORT || 3456;

// Store conversation history per session (in-memory, clears on restart — fine for MVP)
const sessions = {};

function getType(file) {
  const map = { '.html': 'text/html;charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };
  return map[path.extname(file)] || 'text/plain';
}

function buildSystemPrompt(role, difficulty) {
  return `你是一个专业的${role}面试官，面试难度：${difficulty}。
你的任务：
1. 每次只问一个问题，根据候选人上一轮的回答决定追问方向
2. 面试结束时说"面试结束"，并给出总体评价
3. 评价从四个维度打分（1-10）：专业能力、逻辑表达、沟通技巧、临场应变
4. 每次追问要深挖候选人的实际经验，避免空泛问题
5. 风格专业但不严肃，像真实面试官一样互动

现在开始面试。先做自我介绍，然后问第一个问题。`;
}

function buildEvalPrompt(role, history) {
  return `你是一个${role}面试评估专家。以下是完整面试记录，请给出评价。

面试记录：
${history}

请从以下四个维度打分（1-10分），并给出简短评语和改进建议：
1. 专业能力
2. 逻辑表达
3. 沟通技巧
4. 临场应变

最后给出总分和一句话总结。返回JSON格式：
{"专业能力":8,"逻辑表达":7,"沟通技巧":8,"临场应变":6,"总分":29,"总结":"整体表现良好，专业基础扎实，但临场应变能力有待提升，建议多练习行为面试题。","建议":["改进点1","改进点2"]}`;
}

const server = http.createServer(async (req, res) => {
  // API: start interview
  if (req.url === '/api/start' && req.method === 'POST') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { role, difficulty } = JSON.parse(body);
        const sid = Date.now().toString(36);
        const msg = { role: 'system', content: buildSystemPrompt(role, difficulty) };
        sessions[sid] = { role, difficulty, history: [msg], questionCount: 0 };

        const result = await callDeepSeek(sessions[sid].history);
        const reply = result.choices[0].message.content;
        sessions[sid].history.push({ role: 'assistant', content: reply });
        sessions[sid].questionCount = 1;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sid, reply }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // API: answer & continue
  if (req.url === '/api/answer' && req.method === 'POST') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { sid, answer } = JSON.parse(body);
        const s = sessions[sid];
        if (!s) throw new Error('Session expired, please restart');

        s.history.push({ role: 'user', content: answer });
        s.questionCount++;

        // Check if we should end (after ~6-8 exchanges)
        if (s.questionCount >= 12 || answer.includes('结束面试')) {
          const evalPrompt = buildEvalPrompt(s.role, s.history.map(m => `${m.role}: ${m.content}`).join('\n'));
          const evalResult = await callDeepSeek([{ role: 'user', content: evalPrompt }]);
          const raw = evalResult.choices[0].message.content;
          const cleaned = raw.replace(/```json\s*|\s*```/g, '').trim();
          const evaluation = JSON.parse(cleaned);
          delete sessions[sid];
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ done: true, evaluation }));
          return;
        }

        const result = await callDeepSeek(s.history);
        const reply = result.choices[0].message.content;
        s.history.push({ role: 'assistant', content: reply });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ done: false, reply }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Static files
  let file = req.url === '/' ? '/index.html' : req.url;
  let fpath = path.join(__dirname, file);
  if (!fpath.startsWith(__dirname)) { res.writeHead(403); return res.end('403'); }
  try {
    const content = fs.readFileSync(fpath);
    res.writeHead(200, { 'Content-Type': getType(file) });
    res.end(content);
  } catch { res.writeHead(404); res.end('404'); }
});

async function callDeepSeek(messages) {
  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_KEY}` },
    body: JSON.stringify({ model: 'deepseek-chat', messages, temperature: 0.8, max_tokens: 4096 }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'API error');
  return data;
}

server.listen(PORT, () => console.log(`http://localhost:${PORT}`));
