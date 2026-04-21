// hacala-api Worker - Cloudflare D1 Backend

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

async function initDB(db) {
  await db.exec(`CREATE TABLE IF NOT EXISTS plans (id INTEGER PRIMARY KEY AUTOINCREMENT, schoolname TEXT NOT NULL, year TEXT NOT NULL, doctype TEXT NOT NULL, content TEXT NOT NULL, updatedat TEXT NOT NULL, updatedby TEXT, UNIQUE(schoolname, year, doctype))`);
  await db.exec(`CREATE TABLE IF NOT EXISTS supervisors (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role TEXT, createdat TEXT NOT NULL)`);
  await db.exec(`CREATE TABLE IF NOT EXISTS supervisor_schools (id INTEGER PRIMARY KEY AUTOINCREMENT, supervisor_email TEXT NOT NULL, schoolname TEXT NOT NULL, year TEXT NOT NULL, instructor_email TEXT, UNIQUE(supervisor_email, schoolname, year))`);
  await db.exec(`CREATE TABLE IF NOT EXISTS instructors (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role TEXT, createdat TEXT NOT NULL)`);
  await db.exec(`CREATE TABLE IF NOT EXISTS instructor_schools (id INTEGER PRIMARY KEY AUTOINCREMENT, instructor_email TEXT NOT NULL, schoolname TEXT NOT NULL, year TEXT NOT NULL, UNIQUE(instructor_email, schoolname, year))`);
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    const path = url.pathname;
    await initDB(env.DB);

    // ── GET /api/plans ──
    if (request.method === 'GET' && path === '/api/plans') {
      const school = url.searchParams.get('school');
      const year   = url.searchParams.get('year');
      const doctype = url.searchParams.get('doctype');
      if (!school) return json({ error: 'school param required' }, 400);
      let query, params;
      if (doctype) { query = 'SELECT * FROM plans WHERE schoolname=? AND year=? AND doctype=?'; params = [school, year, doctype]; }
      else if (year) { query = 'SELECT * FROM plans WHERE schoolname=? AND year=?'; params = [school, year]; }
      else { query = 'SELECT * FROM plans WHERE schoolname=?'; params = [school]; }
      const { results } = await env.DB.prepare(query).bind(...params).all();
      return json(results.map(r => ({ ...r, content: JSON.parse(r.content) })));
    }

    // ── GET /api/schools ──
    if (request.method === 'GET' && path === '/api/schools') {
      const { results } = await env.DB.prepare('SELECT DISTINCT schoolname, year FROM plans ORDER BY schoolname').all();
      return json(results);
    }

    // ── POST /api/plans ──
    if (request.method === 'POST' && path === '/api/plans') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
      const { schoolname, year, doctype, content, updatedby } = body;
      if (!schoolname || !year || !doctype || !content) return json({ error: 'missing fields' }, 400);
      const updatedat = new Date().toISOString();
      const contentStr = typeof content === 'string' ? content : JSON.stringify(content);
      await env.DB.prepare(`INSERT INTO plans (schoolname,year,doctype,content,updatedat,updatedby) VALUES (?,?,?,?,?,?) ON CONFLICT(schoolname,year,doctype) DO UPDATE SET content=excluded.content,updatedat=excluded.updatedat,updatedby=excluded.updatedby`).bind(schoolname, year, doctype, contentStr, updatedat, updatedby || schoolname).run();
      return json({ ok: true, updatedat });
    }

    // ── GET /api/supervisor?email=... ──
    if (request.method === 'GET' && path === '/api/supervisor') {
      const email = url.searchParams.get('email');
      if (!email) return json({ error: 'email required' }, 400);
      const sup = await env.DB.prepare('SELECT * FROM supervisors WHERE email=?').bind(email).first();
      if (!sup) return json({ error: 'לא נמצאה גישה' }, 403);
      const { results: schools } = await env.DB.prepare(`SELECT ss.schoolname, ss.year, p.doctype FROM supervisor_schools ss LEFT JOIN plans p ON p.schoolname=ss.schoolname AND p.year=ss.year WHERE ss.supervisor_email=? ORDER BY ss.schoolname`).bind(email).all();
      return json({ supervisor: sup, schools });
    }

    // ── GET /api/supervisors ──
    if (request.method === 'GET' && path === '/api/supervisors') {
      const instructor = url.searchParams.get('instructor');
      let results;
      if (instructor) {
        // מדריכה — רק המפקחות שלה
        const r = await env.DB.prepare(`SELECT DISTINCT s.* FROM supervisors s INNER JOIN supervisor_schools ss ON ss.supervisor_email=s.email WHERE ss.instructor_email=? ORDER BY s.name`).bind(instructor).all();
        results = r.results;
      } else {
        const r = await env.DB.prepare('SELECT * FROM supervisors ORDER BY name').all();
        results = r.results;
      }
      const enriched = await Promise.all(results.map(async sup => {
        const { results: schools } = await env.DB.prepare('SELECT schoolname, year FROM supervisor_schools WHERE supervisor_email=?').bind(sup.email).all();
        return { ...sup, schools };
      }));
      return json(enriched);
    }

    // ── POST /api/supervisors ──
    if (request.method === 'POST' && path === '/api/supervisors') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
      const { email, name, role, schools, instructor_email } = body;
      if (!email || !name) return json({ error: 'email and name required' }, 400);
      const createdat = new Date().toISOString();
      await env.DB.prepare(`INSERT INTO supervisors (email,name,role,createdat) VALUES (?,?,?,?) ON CONFLICT(email) DO UPDATE SET name=excluded.name,role=excluded.role`).bind(email, name, role || '', createdat).run();
      if (Array.isArray(schools)) {
        // אם נשלח instructor_email — מחק רק את השיוכים שלו
        if (instructor_email) {
          await env.DB.prepare('DELETE FROM supervisor_schools WHERE supervisor_email=? AND instructor_email=?').bind(email, instructor_email).run();
        } else {
          await env.DB.prepare('DELETE FROM supervisor_schools WHERE supervisor_email=?').bind(email).run();
        }
        for (const s of schools) {
          if (s.schoolname && s.year) {
            await env.DB.prepare(`INSERT OR IGNORE INTO supervisor_schools (supervisor_email,schoolname,year,instructor_email) VALUES (?,?,?,?)`).bind(email, s.schoolname, s.year, instructor_email || null).run();
          }
        }
      }
      return json({ ok: true });
    }

    // ── DELETE /api/supervisors?email=... ──
    if (request.method === 'DELETE' && path === '/api/supervisors') {
      const email = url.searchParams.get('email');
      if (!email) return json({ error: 'email required' }, 400);
      await env.DB.prepare('DELETE FROM supervisors WHERE email=?').bind(email).run();
      await env.DB.prepare('DELETE FROM supervisor_schools WHERE supervisor_email=?').bind(email).run();
      return json({ ok: true });
    }

    // ── GET /api/instructor?email=... ──
    if (request.method === 'GET' && path === '/api/instructor') {
      const email = url.searchParams.get('email');
      if (!email) return json({ error: 'email required' }, 400);
      const inst = await env.DB.prepare('SELECT * FROM instructors WHERE email=?').bind(email).first();
      if (!inst) return json({ error: 'לא נמצאה גישה' }, 403);
      return json(inst);
    }

    // ── GET /api/instructor/schools?email=... ──
    if (request.method === 'GET' && path === '/api/instructor/schools') {
      const email = url.searchParams.get('email');
      if (!email) return json({ error: 'email required' }, 400);
      const { results } = await env.DB.prepare('SELECT schoolname, year FROM instructor_schools WHERE instructor_email=? ORDER BY schoolname').bind(email).all();
      return json(results);
    }

    // ── GET /api/instructors ──
    if (request.method === 'GET' && path === '/api/instructors') {
      const { results } = await env.DB.prepare('SELECT * FROM instructors ORDER BY name').all();
      const enriched = await Promise.all(results.map(async inst => {
        const { results: schools } = await env.DB.prepare('SELECT schoolname, year FROM instructor_schools WHERE instructor_email=?').bind(inst.email).all();
        return { ...inst, schools };
      }));
      return json(enriched);
    }

    // ── POST /api/instructors ──
    if (request.method === 'POST' && path === '/api/instructors') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
      const { email, name, role, schools } = body;
      if (!email || !name) return json({ error: 'email and name required' }, 400);
      const createdat = new Date().toISOString();
      await env.DB.prepare(`INSERT INTO instructors (email,name,role,createdat) VALUES (?,?,?,?) ON CONFLICT(email) DO UPDATE SET name=excluded.name,role=excluded.role`).bind(email, name, role || '', createdat).run();
      if (Array.isArray(schools)) {
        await env.DB.prepare('DELETE FROM instructor_schools WHERE instructor_email=?').bind(email).run();
        for (const s of schools) {
          if (s.schoolname && s.year) {
            await env.DB.prepare(`INSERT OR IGNORE INTO instructor_schools (instructor_email,schoolname,year) VALUES (?,?,?)`).bind(email, s.schoolname, s.year).run();
          }
        }
      }
      return json({ ok: true });
    }

    // ── DELETE /api/instructors?email=... ──
    if (request.method === 'DELETE' && path === '/api/instructors') {
      const email = url.searchParams.get('email');
      if (!email) return json({ error: 'email required' }, 400);
      await env.DB.prepare('DELETE FROM instructors WHERE email=?').bind(email).run();
      await env.DB.prepare('DELETE FROM instructor_schools WHERE instructor_email=?').bind(email).run();
      return json({ ok: true });
    }

    return json({ error: 'Not found' }, 404);
  }
};
