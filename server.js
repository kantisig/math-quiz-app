const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const Groq = require('groq-sdk');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'supersecretkey',
  resave: false,
  saveUninitialized: false
}));

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(20) DEFAULT 'student',
        must_change_password BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS active_subjects (
        subject_name VARCHAR(50) PRIMARY KEY,
        is_active BOOLEAN DEFAULT TRUE
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS questions (
        id SERIAL PRIMARY KEY,
        subject VARCHAR(50) NOT NULL,
        topic VARCHAR(50) NOT NULL,
        question TEXT NOT NULL,
        choices JSONB NOT NULL,
        correct_choice INT NOT NULL,
        difficulty VARCHAR(20) CHECK (difficulty IN ('easy', 'medium', 'hard')),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_quiz_history (
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id) ON DELETE CASCADE,
        question_id INT REFERENCES questions(id) ON DELETE CASCADE,
        chosen_choice INT NOT NULL,
        is_correct BOOLEAN NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS ai_chat_logs (
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id) ON DELETE CASCADE,
        prompt TEXT NOT NULL,
        response TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    const adminCheck = await pool.query("SELECT * FROM users WHERE username = 'admin'");
    if (adminCheck.rows.length === 0) {
      const hash = await bcrypt.hash('thisisnotpassword', 10);
      await pool.query(
        "INSERT INTO users (username, password_hash, role, must_change_password) VALUES ('admin', $1, 'admin', TRUE)",
        [hash]
      );
      console.log("Default Admin created successfully.");
    }
    console.log("Database initialized successfully!");
  } catch (err) {
    console.error("Database initialization error:", err.message);
  }
}
initDB();

const auth = (req, res, next) => req.session.user ? next() : res.status(401).json({ error: 'Unauthorized' });
const isAdmin = (req, res, next) => req.session.user && req.session.user.role === 'admin' ? next() : res.status(403).json({ error: 'Forbidden' });

app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'กรุณากรอก Username และ Password' });

    const userCheck = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (userCheck.rows.length > 0) return res.status(400).json({ error: 'Username นี้ถูกใช้งานแล้ว' });

    const hash = await bcrypt.hash(password, 10);
    await pool.query("INSERT INTO users (username, password_hash, role) VALUES ($1, $2, 'student')", [username, hash]);
    res.json({ success: true, message: 'สมัครสมาชิกสำเร็จ!' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (result.rows.length === 0) return res.status(400).json({ error: 'User not found' });

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(400).json({ error: 'Invalid password' });

    req.session.user = { id: user.id, username: user.username, role: user.role };
    res.json({ success: true, mustChangePassword: user.must_change_password, role: user.role });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.post('/api/admin/upload-json', isAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'กรุณาอัปโหลดไฟล์ JSON' });

    const questions = JSON.parse(req.file.buffer.toString());
    for (const q of questions) {
      await pool.query(
        'INSERT INTO questions (subject, topic, question, choices, correct_choice, difficulty) VALUES ($1, $2, $3, $4, $5, $6)',
        [q.subject, q.topic, q.question, JSON.stringify(q.choices), parseInt(q.correct_choice), q.difficulty]
      );
      await pool.query('INSERT INTO active_subjects (subject_name, is_active) VALUES ($1, TRUE) ON CONFLICT DO NOTHING', [q.subject]);
    }
    res.json({ success: true, count: questions.length });
  } catch (e) {
    res.status(400).json({ error: `Upload Failed: ${e.message}` });
  }
});

app.get('/api/admin/questions', isAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM questions ORDER BY id DESC');
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/student/questions', auth, async (req, res) => {
  try {
    const query = `
      SELECT q.id, q.subject, q.topic, q.question, q.choices, q.difficulty 
      FROM questions q
      JOIN active_subjects s ON q.subject = s.subject_name
      WHERE s.is_active = TRUE
    `;
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/student/submit-answer', auth, async (req, res) => {
  try {
    const { question_id, chosen_choice } = req.body;
    const qRes = await pool.query('SELECT correct_choice FROM questions WHERE id = $1', [question_id]);
    if (qRes.rows.length === 0) return res.status(404).json({ error: 'Question not found' });

    const isCorrect = qRes.rows[0].correct_choice === parseInt(chosen_choice);
    await pool.query(
      'INSERT INTO user_quiz_history (user_id, question_id, chosen_choice, is_correct) VALUES ($1, $2, $3, $4)',
      [req.session.user.id, question_id, chosen_choice, isCorrect]
    );
    res.json({ success: true, isCorrect });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/student/ai-chat', auth, async (req, res) => {
  try {
    const { prompt, apiKey, questionText } = req.body;
    if (!apiKey) return res.status(400).json({ response: 'กรุณากรอก Groq API Key ในช่องด้านบนก่อนครับ' });

    const groq = new Groq({ apiKey });
    const completion = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: 'คุณคือ AI Tutor วิชา Calculus ให้ตอบสั้น กระชับ อธิบายเป็นขั้นตอน ภาษาไทยเข้าใจง่าย' },
        { role: 'user', content: `โจทย์ปัจจุบัน: ${questionText || 'ไม่มี'}\nคำถาม: ${prompt}` }
      ],
      model: 'llama-3.3-70b-versatile',
    });

    const response = completion.choices[0]?.message?.content || 'ไม่สามารถประมวลผลคำตอบได้';
    await pool.query('INSERT INTO ai_chat_logs (user_id, prompt, response) VALUES ($1, $2, $3)', [req.session.user.id, prompt, response]);
    res.json({ response });
  } catch (e) {
    res.status(500).json({ response: `เกิดข้อผิดพลาด: ${e.message}` });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server active on port ${PORT}`));