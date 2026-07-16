// Vercel serverless function — proxies DeepSeek API to protect API key
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { subject, chapter, count = 5 } = req.body;
  if (!subject) return res.status(400).json({ error: 'Missing subject' });

  const prompt = buildPrompt(subject, chapter, count);

  try {
    const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: '你是严格的出题助手，只返回JSON，不返回任何解释文字。' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.8,
        max_tokens: 4096,
      }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'API error');

    const raw = data.choices[0].message.content;
    const cleaned = raw.replace(/```json\s*|\s*```/g, '').trim();
    const questions = JSON.parse(cleaned);

    return res.json({ questions: questions.questions || questions });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}

function buildPrompt(subject, chapter, count) {
  const chapterStr = chapter ? `，章节范围：${chapter}` : '';
  return `你是${subject}的出题专家。请生成${count}道${subject}选择题${chapterStr}。

要求：
1. 题型：单选题（4个选项）
2. 难度：适中，覆盖基础和进阶知识点
3. 每道题包含：题目内容、4个选项(A/B/C/D各一个)、正确答案、详细解析（说明为什么对、为什么错）
4. 格式严格返回 JSON：
{
  "questions": [
    {
      "id": 1,
      "content": "题目内容",
      "options": [
        {"key": "A", "text": "选项内容"},
        {"key": "B", "text": "选项内容"},
        {"key": "C", "text": "选项内容"},
        {"key": "D", "text": "选项内容"}
      ],
      "answer": "A",
      "analysis": "详细解析，说明每道题的正确答案为什么对，错误答案为什么错"
    }
  ]
}`;
}
