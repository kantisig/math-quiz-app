const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const session = require('express-session');
const multer = require('multer');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

app.use(express.json());
app.use(express.static('public'));
app.use(session({
  secret: process.env.SESSION_SECRET || 'supersecretkey',
  resave: false,
  saveUninitialized: false
}));

// Init Default Admin & DB Seeds
async function initDB() {
  const adminCheck = await pool.query("SELECT * FROM users WHERE username = 'admin'");
  if (adminCheck.rows.length === 0) {
    const hash = await bcrypt.hash('thisisnotpassword', 10);
    await pool.query(
      "INSERT INTO users (username, password_hash, role, must_change_password) VALUES ('admin', $1, 'admin', TRUE)",
      [hash]
    );
  }
}
initDB();

// Auth Middlewares
const auth = (req, res, next) => req.session.user ? next() : res.status(401).json({ error: 'Unauthorized' });
const isAdmin = (req, res, next) => req.session.user && req.session.user.role === 'admin' ? next() : res.status(403).json({ error: 'Forbidden' });

// API: Auth & Profile
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
  if (result.rows.length === 0) return res.status(400).json({ error: 'User not found' });

  const user = result.rows[0];
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(400).json({ error: 'Invalid password' });

  req.session.user = { id: user.id, username: user.username, role: user.role };
  res.json({ success: true, mustChangePassword: user.must_change_password, role: user.role });
});

app.post('/api/change-password', auth, async (req, res) => {
  const { newPassword } = req.body;
  const hash = await bcrypt.hash(newPassword, 10);
  await pool.query('UPDATE users SET password_hash = $1, must_change_password = FALSE WHERE id = $2', [hash, req.session.user.id]);
  res.json({ success: true });
});

// API: Admin Operations
app.post('/api/admin/upload-json', isAdmin, upload.single('file'), async (req, res) => {
  try {
    const questions = JSON.parse(req.file.buffer.toString());
    for (const q of questions) {
      await pool.query(
        'INSERT INTO questions (subject, topic, question, choices, correct_choice, difficulty) VALUES ($1, $2, $3, $4, $5, $6)',
        [q.subject, q.topic, q.question, JSON.stringify(q.choices), q.correct_choice, q.difficulty]
      );
      await pool.query('INSERT INTO active_subjects (subject_name, is_active) VALUES ($1, TRUE) ON CONFLICT DO NOTHING', [q.subject]);
    }
    res.json({ success: true, count: questions.length });
  } catch (e) {
    res.status(400).json({ error: 'Invalid JSON format' });
  }
});

app.get('/api/admin/questions', isAdmin, async (req, res) => {
  const result = await pool.query('SELECT * FROM questions ORDER BY id DESC');
  res.json(result.rows);
});

app.get('/api/admin/subjects', isAdmin, async (req, res) => {
  const result = await pool.query('SELECT * FROM active_subjects');
  res.json(result.rows);
});

app.post('/api/admin/toggle-subject', isAdmin, async (req, res) => {
  const { subject_name, is_active } = req.body;
  await pool.query('UPDATE active_subjects SET is_active = $1 WHERE subject_name = $2', [is_active, subject_name]);
  res.json({ success: true });
});

// API: Student Quiz & History
app.get('/api/student/questions', auth, async (req, res) => {
  const query = `
    SELECT q.id, q.subject, q.topic, q.question, q.choices, q.difficulty 
    FROM questions q
    JOIN active_subjects s ON q.subject = s.subject_name
    WHERE s.is_active = TRUE
  `;
  const result = await pool.query(query);
  res.json(result.rows);
});

app.post('/api/student/submit-answer', auth, async (req, res) => {
  const { question_id, chosen_choice } = req.body;
  const qRes = await pool.query('SELECT correct_choice FROM questions WHERE id = $1', [question_id]);
  const isCorrect = qRes.rows[0].correct_choice === chosen_choice;

  await pool.query(
    'INSERT INTO user_quiz_history (user_id, question_id, chosen_choice, is_correct) VALUES ($1, $2, $3, $4)',
    [req.session.user.id, question_id, chosen_choice, isCorrect]
  );
  res.json({ success: true, isCorrect });
});

app.post('/api/student/ai-chat', auth, async (req, res) => {
  const { prompt } = req.body;
  // จำลองคำตอบจาก AI สามารถเชื่อมต่อ OpenAI API เพิ่มเติมได้
  const response = "ระบบบันทึกคำถามของคุณแล้ว: " + prompt; 
  await pool.query('INSERT INTO ai_chat_logs (user_id, prompt, response) VALUES ($1, $2, $3)', [req.session.user.id, prompt, response]);
  res.json({ response });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server active on port ${PORT}`));