// ================================================================
// Code.gs — Google Apps Script backend
// מסגרת ללומד עצמאי — נתוני מורים ותלמידים
//
// גרסה: 2.0 — מודל טוקן קנוני (classToken)
//   token = SHA-256( symbol + '|' + className.toLowerCase() + '|' + institutionPassword )
//   → 16 תווים ראשונים של hash hex
//
// ================================================================

// ── שמות הגיליונות ──────────────────────────────────────────────
var SHEET_TEACHERS = 'teacher-progress';
var SHEET_STUDENTS = 'student-progress';

// ── כותרות עמודות — מורה ──────────────────────────────────────
var TEACHER_HEADERS = [
  'timestamp', 'schoolCode', 'schoolName', 'teacherName', 'className',
  'token', 'mode', 'type', 'status', 'efSkipped', 'answers'
];

// ── כותרות עמודות — תלמיד ─────────────────────────────────────
var STUDENT_HEADERS = [
  'timestamp', 'schoolCode', 'schoolName', 'studentName', 'className',
  'token', 'symbol', 'mode', 'type', 'hasEF', 'answers'
];

// ================================================================
// doPost — קבלת נתוני מורה / תלמיד
// BUG-09/10 FIX: תמיכה ב-text/plain כדי לעקוף CORS preflight
// ================================================================
function doPost(e) {
  try {
    var raw = (e.postData && e.postData.contents) ? e.postData.contents : '';
    var payload = JSON.parse(raw);

    if (!payload || typeof payload !== 'object') {
      return jsonResponse({ status: 'error', message: 'Invalid JSON payload' });
    }

    var isTeacher = (payload.mode === 'teacher' || payload.type === 'teacher-progress');

    if (isTeacher) {
      return saveTeacherRow(payload);
    } else {
      return saveStudentRow(payload);
    }

  } catch (err) {
    return jsonResponse({ status: 'error', message: err.message });
  }
}

// ── שמירת שורת מורה ────────────────────────────────────────────
function saveTeacherRow(p) {
  var sheet = getOrCreateSheet(SHEET_TEACHERS, TEACHER_HEADERS);

  var row = [
    p.timestamp   || new Date().toISOString(),
    p.schoolCode  || '',
    p.schoolName  || p.schoolCode || '',
    p.teacherName || '',
    p.className   || '',
    p.token       || '',
    'teacher',
    'teacher-progress',
    p.status      || 'complete',
    p.efSkipped   ? 'כן' : 'לא',
    JSON.stringify(p.answers || {})
  ];

  sheet.appendRow(row);
  return jsonResponse({ status: 'success', message: 'teacher saved' });
}

// ── שמירת שורת תלמיד ───────────────────────────────────────────
function saveStudentRow(p) {
  var sheet = getOrCreateSheet(SHEET_STUDENTS, STUDENT_HEADERS);

  var row = [
    p.timestamp   || new Date().toISOString(),
    p.schoolCode  || p.symbol || '',
    p.schoolName  || p.schoolCode || p.symbol || '',
    p.studentName || '',
    p.className   || decodeURIComponent(p.className || '') || '',
    p.token       || '',
    p.symbol      || p.schoolCode || '',
    'student',
    'student-progress',
    (p.hasEF || Object.keys(p.answers || {}).some(function(k){ return k.startsWith('ef'); })) ? 'כן' : 'לא',
    JSON.stringify(p.answers || {})
  ];

  sheet.appendRow(row);
  return jsonResponse({ status: 'success', message: 'student saved' });
}

// ================================================================
// doGet — שאילתות משיכת נתונים
//
//   ?action=getTeacherData&token=TOKEN
//     → מחזיר מורים ששמרו עם token זה (token מוסדי = hash(symbol,password))
//
//   ?action=getStudentData&token=TOKEN
//     → מחזיר תלמידים ששמרו עם token זה (token כיתתי = deriveClassToken)
//
//   ?action=getAllData&schoolCode=SYMBOL&password=PASSWORD (גרסה עתידית)
//
// ================================================================
function doGet(e) {
  var params = e.parameter || {};
  var action = params.action || '';

  try {
    if (action === 'getTeacherData') {
      // תמיכה בחיפוש לפי schoolCode (חדש) או token (legacy)
      if (params.schoolCode) return getTeacherDataBySchoolCode(params.schoolCode);
      return getTeacherData(params.token || "");
    }
    if (action === 'getStudentData') {
      return getStudentData(params.token || '');
    }
    // Legacy: direct schoolCode+password (used by old fetchInstitutionalCloudData)
    if (params.schoolCode && params.password) {
      return getLegacyCloudData(params.schoolCode, params.password);
    }
    return jsonResponse({ status: 'error', message: 'Unknown action: ' + action });
  } catch (err) {
    return jsonResponse({ status: 'error', message: err.message });
  }
}

// ── getTeacherData: מורים לפי token מוסדי ──────────────────────
// token מוסדי = deriveToken(symbol, password) = SHA-256(symbol+'::'+password)[0:32]
// (נגזר ב-generateTeacherLink / fetchSchoolData)
function getTeacherData(token) {
  if (!token) return jsonResponse([]);
  var sheet = getOrCreateSheet(SHEET_TEACHERS, TEACHER_HEADERS);
  var rows = getAllRows(sheet);
  var idx = indexOf(TEACHER_HEADERS, 'token');
  var matched = rows.filter(function(r) { return r[idx] === token; });
  return jsonResponse(matched.map(function(r) { return rowToTeacherObj(r); }));
}


// ── getTeacherDataBySchoolCode: מורים לפי סמל מוסד (ללא token) ──
// זו השיטה הנכונה כיוון שהמורים שומרים deriveClassToken (לא deriveToken)
// הדשבורד מעביר ?action=getTeacherData&schoolCode=SYMBOL
function getTeacherDataBySchoolCode(schoolCode) {
  if (!schoolCode) return jsonResponse([]);
  var sheet = getOrCreateSheet(SHEET_TEACHERS, TEACHER_HEADERS);
  var rows = getAllRows(sheet);
  var idx = indexOf(TEACHER_HEADERS, 'schoolCode');
  var matched = rows.filter(function(r) { return String(r[idx]) === String(schoolCode); });
  return jsonResponse(matched.map(function(r) { return rowToTeacherObj(r); }));
}

// ── getStudentData: תלמידים לפי token כיתתי ────────────────────
// token כיתתי = deriveClassToken(symbol, className, password) = SHA-256(symbol+'|'+className.lower()+'|'+password)[0:16]
function getStudentData(token) {
  if (!token) return jsonResponse([]);
  var sheet = getOrCreateSheet(SHEET_STUDENTS, STUDENT_HEADERS);
  var rows = getAllRows(sheet);
  var idx = indexOf(STUDENT_HEADERS, 'token');
  var matched = rows.filter(function(r) { return r[idx] === token; });
  return jsonResponse(matched.map(function(r) { return rowToStudentObj(r); }));
}

// ── Legacy cloud fetch: כל נתוני המוסד לפי schoolCode+password ─
// (לתאימות לאחור עם fetchInstitutionalCloudData)
function getLegacyCloudData(schoolCode, password) {
  var teacherSheet = getOrCreateSheet(SHEET_TEACHERS, TEACHER_HEADERS);
  var studentSheet = getOrCreateSheet(SHEET_STUDENTS, STUDENT_HEADERS);

  var tRows = getAllRows(teacherSheet);
  var sRows = getAllRows(studentSheet);

  var scIdx = indexOf(TEACHER_HEADERS, 'schoolCode');
  var ssIdx = indexOf(STUDENT_HEADERS, 'schoolCode');

  var teachers = tRows
    .filter(function(r) { return r[scIdx] === schoolCode; })
    .map(function(r) { return rowToTeacherObj(r); });

  var students = sRows
    .filter(function(r) { return r[ssIdx] === schoolCode; })
    .map(function(r) { return rowToStudentObj(r); });

  return jsonResponse({ status: 'success', rows: teachers.concat(students) });
}

// ================================================================
// Helpers
// ================================================================

function getOrCreateSheet(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
  } else {
    // Ensure headers exist in row 1
    var firstRow = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
    var missing = headers.some(function(h, i) { return firstRow[i] !== h; });
    if (missing) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      sheet.setFrozenRows(1);
    }
  }
  return sheet;
}

function getAllRows(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var lastCol = sheet.getLastColumn();
  if (lastCol < 1) return [];
  return sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
}

function indexOf(headers, col) {
  return headers.indexOf(col);
}

function rowToTeacherObj(r) {
  var h = TEACHER_HEADERS;
  var obj = {};
  h.forEach(function(key, i) { obj[key] = r[i] !== undefined ? r[i] : ''; });

  // Parse answers from JSON string
  try { obj.answers = typeof obj.answers === 'string' ? JSON.parse(obj.answers) : (obj.answers || {}); }
  catch(e) { obj.answers = {}; }

  // Normalize efSkipped to boolean
  obj.efSkipped = (obj.efSkipped === 'כן' || obj.efSkipped === true || obj.efSkipped === 'true');

  return obj;
}

function rowToStudentObj(r) {
  var h = STUDENT_HEADERS;
  var obj = {};
  h.forEach(function(key, i) { obj[key] = r[i] !== undefined ? r[i] : ''; });

  // Parse answers from JSON string
  try { obj.answers = typeof obj.answers === 'string' ? JSON.parse(obj.answers) : (obj.answers || {}); }
  catch(e) { obj.answers = {}; }

  // Normalize hasEF to boolean
  obj.hasEF = (obj.hasEF === 'כן' || obj.hasEF === true || obj.hasEF === 'true');

  return obj;
}

function jsonResponse(data) {
  var output = ContentService.createTextOutput(JSON.stringify(data));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}
