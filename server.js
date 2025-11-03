const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(express.json());
app.use(express.static('public', { index: false })); // Don't serve index.html for all routes
app.use('/uploads', express.static('uploads'));
app.use('/assets', express.static('assets'));

// Debug: Log all PUT requests (AFTER body parser, BEFORE routes)
app.use((req, res, next) => {
    if (req.method === 'PUT') {
        console.log(`[DEBUG PUT] Method: ${req.method}, Path: ${req.path}, OriginalUrl: ${req.originalUrl}`);
        console.log(`[DEBUG PUT] Headers:`, req.headers);
        console.log(`[DEBUG PUT] Body available:`, !!req.body);
        if (req.body) {
            console.log(`[DEBUG PUT] Body keys:`, Object.keys(req.body));
        }
    }
    next();
});

// Ensure directories exist
const uploadsDir = path.join(__dirname, 'uploads', 'photos');
const assetsDir = path.join(__dirname, 'public', 'assets');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|gif|webp/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);
        if (extname && mimetype) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed'));
        }
    }
});

// Initialize SQLite Database
const db = new sqlite3.Database('students.db', (err) => {
    if (err) {
        console.error('Error opening database:', err.message);
    } else {
        console.log('Connected to SQLite database');
        // Create tables
        db.run(`CREATE TABLE IF NOT EXISTS students (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            id_number TEXT NOT NULL,
            exam_number TEXT NOT NULL,
            student_name TEXT NOT NULL,
            photo_url TEXT,
            exam_type TEXT NOT NULL,
            level TEXT,
            exam_link TEXT,
            subjects_json TEXT NOT NULL,
            total_marks REAL NOT NULL,
            grade TEXT NOT NULL,
            exam_date TEXT NOT NULL,
            published INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        
        // Note: exam_number is no longer UNIQUE - same student can use same exam_number for both exams
        // We handle duplicate prevention in application logic (same exam_number + different id_number = reject)
        
        // Add columns if they don't exist (for existing databases)
        db.run(`ALTER TABLE students ADD COLUMN published INTEGER DEFAULT 0`, (err) => {
            // Ignore error if column already exists
        });
        db.run(`ALTER TABLE students ADD COLUMN level TEXT`, (err) => {
            // Ignore error if column already exists
        });
        db.run(`ALTER TABLE students ADD COLUMN exam_link TEXT`, (err) => {
            // Ignore error if column already exists
        });

        db.run(`CREATE TABLE IF NOT EXISTS admins (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // Create default admin if not exists
        db.get("SELECT * FROM admins WHERE username = 'admin'", (err, row) => {
            if (!row) {
                const bcrypt = require('bcryptjs');
                const hash = bcrypt.hashSync('admin123', 10);
                db.run("INSERT INTO admins (username, password_hash) VALUES (?, ?)", ['admin', hash]);
            }
        });
    }
});

// Helper function to recreate table without UNIQUE constraint on exam_number
function recreateTableWithoutUniqueConstraint(db, callback) {
    db.serialize(function() {
        // Create backup table
        db.run(`CREATE TABLE IF NOT EXISTS students_backup AS SELECT * FROM students`, function(err) {
            if (err) {
                console.error('Error creating backup:', err);
                return callback(err);
            }
            
            // Drop old table
            db.run(`DROP TABLE IF EXISTS students`, function(err2) {
                if (err2) {
                    console.error('Error dropping table:', err2);
                    return callback(err2);
                }
                
                // Create new table without UNIQUE constraint on exam_number
                db.run(`CREATE TABLE students (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    id_number TEXT NOT NULL,
                    exam_number TEXT NOT NULL,
                    student_name TEXT NOT NULL,
                    photo_url TEXT,
                    exam_type TEXT NOT NULL,
                    level TEXT,
                    exam_link TEXT,
                    subjects_json TEXT NOT NULL,
                    total_marks REAL NOT NULL,
                    grade TEXT NOT NULL,
                    exam_date TEXT NOT NULL,
                    published INTEGER DEFAULT 0,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )`, function(err3) {
                    if (err3) {
                        console.error('Error creating new table:', err3);
                        return callback(err3);
                    }
                    
                    // Copy data back
                    db.run(`INSERT INTO students SELECT * FROM students_backup`, function(err4) {
                        if (err4) {
                            console.error('Error copying data:', err4);
                            return callback(err4);
                        }
                        
                        // Drop backup
                        db.run(`DROP TABLE IF EXISTS students_backup`, function(err5) {
                            console.log('✅ Table recreated successfully without UNIQUE constraint on exam_number');
                            callback(null);
                        });
                    });
                });
            });
        });
    });
}

// Helper Functions
function calculateGrade(totalMarks, maxMarks = 100) {
    const percentage = (totalMarks / maxMarks) * 100;
    if (percentage >= 90) return 'A';
    if (percentage >= 80) return 'B';
    if (percentage >= 70) return 'C';
    if (percentage >= 60) return 'D';
    return 'F';
}

function generateExamNumber() {
    return new Promise((resolve, reject) => {
        const year = new Date().getFullYear();
        db.get("SELECT exam_number FROM students ORDER BY id DESC LIMIT 1", (err, row) => {
            if (err) {
                reject(err);
            } else {
                let newNum = 1;
                if (row && row.exam_number) {
                    const match = row.exam_number.match(/\d+$/);
                    if (match) {
                        newNum = parseInt(match[0]) + 1;
                    }
                }
                resolve(`EX-${year}-${String(newNum).padStart(3, '0')}`);
            }
        });
    });
}

// API Routes

// Get all students (admin only)
app.get('/api/students', async (req, res) => {
    db.all("SELECT * FROM students ORDER BY created_at DESC", [], async (err, rows) => {
        if (err) {
            console.error('Error fetching students:', err);
            res.status(500).json({ error: err.message });
        } else {
            try {
                // Process students and generate QR codes
                const students = await Promise.all(rows.map(async (row) => {
                    try {
                        // Try to parse subjects_json, handle both object and array formats
                        let subjects = [];
                        if (row.subjects_json) {
                            const parsed = JSON.parse(row.subjects_json);
                            // If it's an object with midterm/final (Both type), keep it as is
                            // Otherwise convert to array if needed
                            subjects = parsed;
                        }
                        
                        // Generate QR code for this student
                        const qrUrl = `${req.protocol}://${req.get('host')}/result/${row.exam_number}`;
                        let qrCodeData = null;
                        try {
                            qrCodeData = await QRCode.toDataURL(qrUrl, {
                                errorCorrectionLevel: 'M',
                                type: 'image/png',
                                quality: 0.92,
                                margin: 1,
                                width: 300
                            });
                        } catch (qrErr) {
                            console.error('Error generating QR code for student', row.id, ':', qrErr);
                        }
                        
                        return {
                            ...row,
                            subjects: subjects,
                            qr_code_data: qrCodeData,
                            qr_url: qrUrl
                        };
                    } catch (parseErr) {
                        console.error('Error parsing subjects_json for student', row.id, ':', parseErr);
                        // Return student with empty subjects array if parsing fails
                        const qrUrl = `${req.protocol}://${req.get('host')}/result/${row.exam_number}`;
                        let qrCodeData = null;
                        try {
                            qrCodeData = await QRCode.toDataURL(qrUrl, {
                                errorCorrectionLevel: 'M',
                                type: 'image/png',
                                quality: 0.92,
                                margin: 1,
                                width: 300
                            });
                        } catch (qrErr) {
                            console.error('Error generating QR code for student', row.id, ':', qrErr);
                        }
                        
                        return {
                            ...row,
                            subjects: [],
                            qr_code_data: qrCodeData,
                            qr_url: qrUrl
                        };
                    }
                }));
                
                res.json(students);
            } catch (mapErr) {
                console.error('Error mapping students:', mapErr);
                res.status(500).json({ error: 'Error processing students data: ' + mapErr.message });
            }
        }
    });
});

// Get student result by exam number (public - only published)
// Returns ALL records with this exam_number (can be multiple: midterm, final, or both)
app.get('/api/result/:examNumber', (req, res) => {
    const examNumber = req.params.examNumber;
    db.all("SELECT * FROM students WHERE exam_number = ? AND published = 1 ORDER BY exam_type ASC, created_at ASC", [examNumber], async (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
        } else if (!rows || rows.length === 0) {
            res.status(404).json({ error: 'Student not found' });
        } else {
            // If only one record, return as single student (backward compatible)
            if (rows.length === 1) {
                const student = {
                    ...rows[0],
                    subjects: JSON.parse(rows[0].subjects_json)
                };
                
                const qrUrl = `${req.protocol}://${req.get('host')}/result/${examNumber}`;
                try {
                    const qrCodeData = await QRCode.toDataURL(qrUrl);
                    student.qr_code_data = qrCodeData;
                    student.qr_url = qrUrl;
                    res.json({ success: true, student });
                } catch (qrErr) {
                    res.json({ success: true, student });
                }
            } else {
                // Multiple records (midterm + final) - return as array
                const students = rows.map(row => ({
                    ...row,
                    subjects: JSON.parse(row.subjects_json)
                }));
                
                const qrUrl = `${req.protocol}://${req.get('host')}/result/${examNumber}`;
                try {
                    const qrCodeData = await QRCode.toDataURL(qrUrl);
                    res.json({ 
                        success: true, 
                        students: students,
                        student: students[0], // First one for backward compatibility
                        multiple: true,
                        qr_code_data: qrCodeData,
                        qr_url: qrUrl
                    });
                } catch (qrErr) {
                    res.json({ 
                        success: true, 
                        students: students,
                        student: students[0],
                        multiple: true
                    });
                }
            }
        }
    });
});

// Search result (public - only published)
// Returns ALL records with this exam_number (can be multiple: midterm, final, or both)
app.get('/api/result', (req, res) => {
    const examNumber = req.query.exam;
    if (!examNumber) {
        return res.status(400).json({ error: 'Exam number required' });
    }
    
    db.all("SELECT * FROM students WHERE exam_number = ? AND published = 1 ORDER BY exam_type ASC, created_at ASC", [examNumber], async (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
        } else if (!rows || rows.length === 0) {
            res.status(404).json({ error: 'Student not found' });
        } else {
            // If only one record, return as single student (backward compatible)
            if (rows.length === 1) {
                const student = {
                    ...rows[0],
                    subjects: JSON.parse(rows[0].subjects_json)
                };
                
                const qrUrl = `${req.protocol}://${req.get('host')}/result/${examNumber}`;
                try {
                    const qrCodeData = await QRCode.toDataURL(qrUrl);
                    student.qr_code_data = qrCodeData;
                    student.qr_url = qrUrl;
                    res.json({ success: true, student });
                } catch (qrErr) {
                    res.json({ success: true, student });
                }
            } else {
                // Multiple records (midterm + final) - return as array
                const students = rows.map(row => ({
                    ...row,
                    subjects: JSON.parse(row.subjects_json)
                }));
                
                const qrUrl = `${req.protocol}://${req.get('host')}/result/${examNumber}`;
                try {
                    const qrCodeData = await QRCode.toDataURL(qrUrl);
                    res.json({ 
                        success: true, 
                        students: students,
                        student: students[0], // First one for backward compatibility
                        multiple: true,
                        qr_code_data: qrCodeData,
                        qr_url: qrUrl
                    });
                } catch (qrErr) {
                    res.json({ 
                        success: true, 
                        students: students,
                        student: students[0],
                        multiple: true
                    });
                }
            }
        }
    });
});

// Add student (admin only)
app.post('/api/students/add', upload.single('photo'), async (req, res) => {
    try {
        const { student_name, id_number, exam_number, exam_type, level, exam_link, subjects, exam_date, midterm_max_marks, final_max_marks } = req.body;
        
        if (!student_name || !id_number) {
            return res.status(400).json({ error: 'Name and ID are required' });
        }

        let subjectsParsed = typeof subjects === 'string' ? JSON.parse(subjects) : subjects;
        
        // Get max marks from request (defaults: midterm=40, final=100 if not provided)
        const midtermMax = parseInt(midterm_max_marks) || 40; // Default 40 for midterm
        const finalMax = parseInt(final_max_marks) || 100; // Default 100 for final
        
        // Validate max marks only if subjects are provided - check if we have subjects to validate
        let hasSubjects = false;
        if (exam_type === 'Both' && subjectsParsed && typeof subjectsParsed === 'object' && !Array.isArray(subjectsParsed)) {
            const midtermSubjects = subjectsParsed.midterm || [];
            const finalSubjects = subjectsParsed.final || [];
            hasSubjects = (midtermSubjects.length > 0 && midtermSubjects.some(s => s.name && s.name.trim() !== '')) ||
                         (finalSubjects.length > 0 && finalSubjects.some(s => s.name && s.name.trim() !== ''));
        } else if (Array.isArray(subjectsParsed)) {
            hasSubjects = subjectsParsed.length > 0 && subjectsParsed.some(s => s.name && s.name.trim() !== '');
        }
        
        // Only validate if subjects are provided
        if (hasSubjects) {
            if (exam_type === 'Both') {
                const midtermSubjects = (subjectsParsed && typeof subjectsParsed === 'object' && !Array.isArray(subjectsParsed)) ? (subjectsParsed.midterm || []) : [];
                const finalSubjects = (subjectsParsed && typeof subjectsParsed === 'object' && !Array.isArray(subjectsParsed)) ? (subjectsParsed.final || []) : [];
                const hasMidterm = midtermSubjects.some(s => s.name && s.name.trim() !== '');
                const hasFinal = finalSubjects.some(s => s.name && s.name.trim() !== '');
                
                if (hasMidterm && (!midterm_max_marks || parseInt(midterm_max_marks) <= 0)) {
                    return res.status(400).json({ error: 'Max marks for midterm is required when adding midterm subjects' });
                }
                if (hasFinal && (!final_max_marks || parseInt(final_max_marks) <= 0)) {
                    return res.status(400).json({ error: 'Max marks for final is required when adding final subjects' });
                }
            } else if (exam_type === 'Midterm' && (!midterm_max_marks || parseInt(midterm_max_marks) <= 0)) {
                return res.status(400).json({ error: 'Max marks for midterm is required when adding subjects' });
            } else if (exam_type === 'Final' && (!final_max_marks || parseInt(final_max_marks) <= 0)) {
                return res.status(400).json({ error: 'Max marks for final is required when adding subjects' });
            }
        }
        
        // Handle subjects structure - can be array or object { midterm: [...], final: [...] }
        let totalMarks = 0;
        let maxMarks = 100;
        let grade = 'N/A';
        let finalSubjectsToStore = subjectsParsed;
        
        // If exam_type is "Both" and subjects is an object with midterm/final
        if (exam_type === 'Both' && subjectsParsed && typeof subjectsParsed === 'object' && !Array.isArray(subjectsParsed)) {
            // Calculate total from both midterm and final
            const midtermSubjects = subjectsParsed.midterm || [];
            const finalSubjects = subjectsParsed.final || [];
            const validMidterm = midtermSubjects.filter(s => s.name && s.name.trim() !== '');
            const validFinal = finalSubjects.filter(s => s.name && s.name.trim() !== '');
            const allSubjects = [...validMidterm, ...validFinal];
            
            if (allSubjects.length > 0) {
                totalMarks = allSubjects.reduce((sum, s) => sum + (parseFloat(s.mark) || 0), 0);
                // Calculate max marks: midterm subjects * midtermMax + final subjects * finalMax
                maxMarks = (validMidterm.length * midtermMax) + (validFinal.length * finalMax);
                grade = calculateGrade(totalMarks, maxMarks);
            }
            finalSubjectsToStore = subjectsParsed; // Keep object structure
        } else if (Array.isArray(subjectsParsed)) {
            // Handle array format (Midterm or Final only, or old format)
            const validSubjects = subjectsParsed.filter(s => s.name && s.name.trim() !== '');
            if (validSubjects.length > 0) {
                totalMarks = validSubjects.reduce((sum, s) => sum + (parseFloat(s.mark) || 0), 0);
                // Use appropriate max marks based on exam type
                const currentMax = exam_type === 'Midterm' ? midtermMax : finalMax;
                maxMarks = validSubjects.length * currentMax;
                grade = calculateGrade(totalMarks, maxMarks);
            }
            finalSubjectsToStore = validSubjects;
        }

        let finalExamNumber = exam_number || await generateExamNumber();
        
        // Step 1: Check if exam_number exists with a DIFFERENT id_number - REJECT immediately
        db.get("SELECT id_number FROM students WHERE exam_number = ? AND id_number != ? LIMIT 1", [finalExamNumber, id_number], (checkErr1, checkRow1) => {
            if (checkErr1) {
                return res.status(500).json({ error: checkErr1.message });
            }
            
            // If exam_number exists for a different student, REJECT
            if (checkRow1) {
                return res.status(400).json({ error: 'Exam number already exists for another student. Each student must have a unique exam number.' });
            }
            
            // Step 2: Check if same student already has this exam_number with same exam_type - UPDATE
            db.get("SELECT id, id_number, exam_type FROM students WHERE exam_number = ? AND id_number = ? AND exam_type = ?", [finalExamNumber, id_number, exam_type], (checkErr2, checkRow2) => {
                if (checkErr2) {
                    return res.status(500).json({ error: checkErr2.message });
                }
                
                if (checkRow2) {
                    // Same student, same exam_number, same exam_type - UPDATE existing record
                    const existingId = checkRow2.id;
                    
                    let photoUrl = 'https://via.placeholder.com/150?text=Student';
                    if (req.file) {
                        photoUrl = `/uploads/photos/${req.file.filename}`;
                    }
                    const examDate = exam_date || new Date().toISOString().split('T')[0];
                    
                    db.run(
                        `UPDATE students SET student_name = ?, level = ?, exam_link = ?, subjects_json = ?, total_marks = ?, grade = ?, exam_date = ?, photo_url = COALESCE(?, photo_url) WHERE id = ?`,
                        [student_name, level || null, exam_link || null, JSON.stringify(finalSubjectsToStore), totalMarks, grade, examDate, req.file ? `/uploads/photos/${req.file.filename}` : null, existingId],
                        async function(updateErr) {
                            if (updateErr) {
                                console.error('Update Error:', updateErr);
                                return res.status(500).json({ error: updateErr.message });
                            }
                            // Generate QR code for the student
                            const qrUrl = `${req.protocol}://${req.get('host')}/result/${finalExamNumber}`;
                            try {
                                const qrCodeData = await QRCode.toDataURL(qrUrl, {
                                    errorCorrectionLevel: 'M',
                                    type: 'image/png',
                                    quality: 0.92,
                                    margin: 1,
                                    width: 300
                                });
                                return res.json({ 
                                    success: true, 
                                    message: `Student ${exam_type} record updated successfully`,
                                    student: {
                                        id: existingId,
                                        exam_number: finalExamNumber,
                                        qr_code_data: qrCodeData,
                                        qr_url: qrUrl
                                    }
                                });
                            } catch (qrErr) {
                                console.error('QR Code generation error:', qrErr);
                                return res.json({ 
                                    success: true, 
                                    message: `Student ${exam_type} record updated successfully`,
                                    student: {
                                        id: existingId,
                                        exam_number: finalExamNumber,
                                        qr_url: qrUrl
                                    }
                                });
                            }
                        }
                    );
                    return;
                }
                
                // Step 3: Same student, same exam_number, but different exam_type (Midterm vs Final) - ALLOW INSERT
                // OR completely new exam_number - ALLOW INSERT
                let photoUrl = 'https://via.placeholder.com/150?text=Student';
                if (req.file) {
                    photoUrl = `/uploads/photos/${req.file.filename}`;
                }

                const examDate = exam_date || new Date().toISOString().split('T')[0];

                db.run(
                    `INSERT INTO students (id_number, exam_number, student_name, photo_url, exam_type, level, exam_link, subjects_json, total_marks, grade, exam_date, published)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
                    [id_number, finalExamNumber, student_name, photoUrl, exam_type, level || null, exam_link || null, JSON.stringify(finalSubjectsToStore), totalMarks, grade, examDate],
                    async function(err) {
                        if (err) {
                            // If UNIQUE constraint error (old database), check the situation
                            if (err.message.includes('UNIQUE constraint') || err.message.includes('unique constraint')) {
                                // Check all records with this exam_number
                                db.all("SELECT id, id_number, exam_type FROM students WHERE exam_number = ?", [finalExamNumber], (checkErr3, checkRows3) => {
                                    if (checkErr3) {
                                        return res.status(500).json({ error: checkErr3.message });
                                    }
                                    
                                    // Check if any record belongs to a different student
                                    const differentStudent = checkRows3.find(row => row.id_number !== id_number);
                                    if (differentStudent) {
                                        return res.status(400).json({ error: 'Exam number already exists for another student. Each student must have a unique exam number.' });
                                    }
                                    
                                    // All records belong to same student - check if same exam_type already exists
                                    const sameExamType = checkRows3.find(row => row.exam_type === exam_type);
                                    if (sameExamType) {
                                        // Same student, same exam_type - should have been caught earlier, but update anyway
                                        db.run(
                                            `UPDATE students SET student_name = ?, level = ?, exam_link = ?, subjects_json = ?, total_marks = ?, grade = ?, exam_date = ?, photo_url = COALESCE(?, photo_url) WHERE id = ?`,
                                            [student_name, level || null, exam_link || null, JSON.stringify(finalSubjectsToStore), totalMarks, grade, examDate, req.file ? `/uploads/photos/${req.file.filename}` : null, sameExamType.id],
                                            async function(updateErr) {
                                                if (updateErr) {
                                                    return res.status(500).json({ error: 'Failed to update: ' + updateErr.message });
                                                }
                                                // Generate QR code for the student
                                                const qrUrl = `${req.protocol}://${req.get('host')}/result/${finalExamNumber}`;
                                                try {
                                                    const qrCodeData = await QRCode.toDataURL(qrUrl, {
                                                        errorCorrectionLevel: 'M',
                                                        type: 'image/png',
                                                        quality: 0.92,
                                                        margin: 1,
                                                        width: 300
                                                    });
                                                    return res.json({ 
                                                        success: true, 
                                                        message: `Student ${exam_type} record updated successfully`,
                                                        student: {
                                                            id: sameExamType.id,
                                                            exam_number: finalExamNumber,
                                                            qr_code_data: qrCodeData,
                                                            qr_url: qrUrl
                                                        }
                                                    });
                                                } catch (qrErr) {
                                                    console.error('QR Code generation error:', qrErr);
                                                    return res.json({ 
                                                        success: true, 
                                                        message: `Student ${exam_type} record updated successfully`,
                                                        student: {
                                                            id: sameExamType.id,
                                                            exam_number: finalExamNumber,
                                                            qr_url: qrUrl
                                                        }
                                                    });
                                                }
                                            }
                                        );
                                    } else {
                                        // Same student, different exam_type - UNIQUE constraint prevents INSERT
                                        // Solution: Create new table, copy data, replace old table
                                        // But for now, let's try a workaround: use a modified exam_number temporarily
                                        // Actually, better: recreate table without UNIQUE constraint
                                        console.log('Attempting to fix UNIQUE constraint issue...');
                                        recreateTableWithoutUniqueConstraint(db, function(recreateErr) {
                                            if (recreateErr) {
                                                return res.status(400).json({ 
                                                    error: 'Cannot add second exam for same student: Database constraint. Please contact administrator to fix the database.' 
                                                });
                                            }
                                            // Retry the insert after recreating table
                                            db.run(
                                                `INSERT INTO students (id_number, exam_number, student_name, photo_url, exam_type, level, exam_link, subjects_json, total_marks, grade, exam_date, published)
                                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
                                                [id_number, finalExamNumber, student_name, photoUrl, exam_type, level || null, exam_link || null, JSON.stringify(finalSubjectsToStore), totalMarks, grade, examDate],
                                                async function(retryErr) {
                                                    if (retryErr) {
                                                        return res.status(500).json({ error: 'Failed after fix: ' + retryErr.message });
                                                    }
                                                    // Generate QR code for the newly added student
                                                    const qrUrl = `${req.protocol}://${req.get('host')}/result/${finalExamNumber}`;
                                                    try {
                                                        const qrCodeData = await QRCode.toDataURL(qrUrl, {
                                                            errorCorrectionLevel: 'M',
                                                            type: 'image/png',
                                                            quality: 0.92,
                                                            margin: 1,
                                                            width: 300
                                                        });
                                                        return res.json({ 
                                                            success: true, 
                                                            message: 'Student added successfully (database fixed)',
                                                            student: {
                                                                id: this.lastID,
                                                                exam_number: finalExamNumber,
                                                                qr_code_data: qrCodeData,
                                                                qr_url: qrUrl
                                                            }
                                                        });
                                                    } catch (qrErr) {
                                                        console.error('QR Code generation error:', qrErr);
                                                        return res.json({ 
                                                            success: true, 
                                                            message: 'Student added successfully (database fixed)',
                                                            student: {
                                                                id: this.lastID,
                                                                exam_number: finalExamNumber,
                                                                qr_url: qrUrl
                                                            }
                                                        });
                                                    }
                                                }
                                            );
                                        });
                                    }
                                });
                            } else {
                                res.status(500).json({ error: err.message });
                            }
                        } else {
                            // Generate QR code for the newly added student
                            const qrUrl = `${req.protocol}://${req.get('host')}/result/${finalExamNumber}`;
                            try {
                                const qrCodeData = await QRCode.toDataURL(qrUrl, {
                                    errorCorrectionLevel: 'M',
                                    type: 'image/png',
                                    quality: 0.92,
                                    margin: 1,
                                    width: 300
                                });
                                res.json({ 
                                    success: true, 
                                    message: 'Student added successfully',
                                    student: {
                                        id: this.lastID,
                                        exam_number: finalExamNumber,
                                        qr_code_data: qrCodeData,
                                        qr_url: qrUrl
                                    }
                                });
                            } catch (qrErr) {
                                console.error('QR Code generation error:', qrErr);
                                res.json({ 
                                    success: true, 
                                    message: 'Student added successfully',
                                    student: {
                                        id: this.lastID,
                                        exam_number: finalExamNumber,
                                        qr_url: qrUrl
                                    }
                                });
                            }
                        }
                    }
                );
            });
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Download QR code as image file - MUST BE BEFORE /api/students/:id routes
app.get('/api/students/:id/qr-download', async (req, res) => {
    console.log('QR download route hit:', req.params.id); // Debug log
    const studentId = req.params.id;
    db.get("SELECT exam_number, student_name FROM students WHERE id = ?", [studentId], async (err, row) => {
        if (err) {
            res.status(500).json({ error: err.message });
        } else if (!row) {
            res.status(404).json({ error: 'Student not found' });
        } else {
            const qrUrl = `${req.protocol}://${req.get('host')}/result/${row.exam_number}`;
            try {
                const qrCodeBuffer = await QRCode.toBuffer(qrUrl, {
                    errorCorrectionLevel: 'M',
                    type: 'png',
                    width: 500
                });
                res.setHeader('Content-Type', 'image/png');
                const safeFilename = `${row.exam_number}.png`;
                res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
                res.send(qrCodeBuffer);
            } catch (qrErr) {
                console.error('QR Download Error:', qrErr);
                res.status(500).json({ error: 'Error generating QR code' });
            }
        }
    });
});

// Get QR code data URL for printing - MUST BE BEFORE /api/students/:id routes  
app.get('/api/students/:id/qr', async (req, res) => {
    console.log('QR code route hit:', req.params.id); // Debug log
    const studentId = req.params.id;
    db.get("SELECT exam_number FROM students WHERE id = ?", [studentId], async (err, row) => {
        if (err) {
            console.error('QR Code DB Error:', err);
            res.status(500).json({ error: err.message });
        } else if (!row) {
            res.status(404).json({ error: 'Student not found' });
        } else {
            const qrUrl = `${req.protocol}://${req.get('host')}/result/${row.exam_number}`;
            try {
                const qrCodeData = await QRCode.toDataURL(qrUrl, {
                    errorCorrectionLevel: 'M',
                    type: 'image/png',
                    quality: 0.92,
                    margin: 1,
                    width: 300
                });
                res.json({ success: true, qr_code_data: qrCodeData, qr_url: qrUrl });
            } catch (qrErr) {
                console.error('QR Code Generation Error:', qrErr);
                res.status(500).json({ error: 'Error generating QR code: ' + qrErr.message });
            }
        }
    });
});

// Publish/Unpublish student - MUST BE BEFORE /api/students/:id routes
app.put('/api/students/:id/publish', (req, res) => {
    const studentId = req.params.id;
    const { published } = req.body;
    db.run("UPDATE students SET published = ? WHERE id = ?", [published ? 1 : 0, studentId], (err) => {
        if (err) {
            console.error('Publish Error:', err);
            res.status(500).json({ error: err.message });
        } else {
            res.json({ success: true, message: `Student ${published ? 'published' : 'unpublished'}` });
        }
    });
});

// Update student
app.put('/api/students/:id', upload.single('photo'), (req, res) => {
    const { student_name, id_number, exam_type, level, exam_link, subjects, exam_date, midterm_max_marks, final_max_marks } = req.body;
    const studentId = req.params.id;

    let subjectsParsed = typeof subjects === 'string' ? JSON.parse(subjects) : subjects;
    
    // Get max marks from request (defaults: midterm=40, final=100 if not provided)
    const midtermMax = parseInt(midterm_max_marks) || 40; // Default 40 for midterm
    const finalMax = parseInt(final_max_marks) || 100; // Default 100 for final
    
    // Validate max marks only if subjects are provided
    let hasSubjects = false;
    if (exam_type === 'Both' && subjectsParsed && typeof subjectsParsed === 'object' && !Array.isArray(subjectsParsed)) {
        const midtermSubjects = subjectsParsed.midterm || [];
        const finalSubjects = subjectsParsed.final || [];
        hasSubjects = (midtermSubjects.length > 0 && midtermSubjects.some(s => s.name && s.name.trim() !== '')) ||
                     (finalSubjects.length > 0 && finalSubjects.some(s => s.name && s.name.trim() !== ''));
    } else if (Array.isArray(subjectsParsed)) {
        hasSubjects = subjectsParsed.length > 0 && subjectsParsed.some(s => s.name && s.name.trim() !== '');
    }
    
    // Only validate if subjects are provided
    if (hasSubjects) {
        if (exam_type === 'Both') {
            const midtermSubjects = (subjectsParsed && typeof subjectsParsed === 'object' && !Array.isArray(subjectsParsed)) ? (subjectsParsed.midterm || []) : [];
            const finalSubjects = (subjectsParsed && typeof subjectsParsed === 'object' && !Array.isArray(subjectsParsed)) ? (subjectsParsed.final || []) : [];
            const hasMidterm = midtermSubjects.some(s => s.name && s.name.trim() !== '');
            const hasFinal = finalSubjects.some(s => s.name && s.name.trim() !== '');
            
            if (hasMidterm && (!midterm_max_marks || parseInt(midterm_max_marks) <= 0)) {
                return res.status(400).json({ error: 'Max marks for midterm is required when adding midterm subjects' });
            }
            if (hasFinal && (!final_max_marks || parseInt(final_max_marks) <= 0)) {
                return res.status(400).json({ error: 'Max marks for final is required when adding final subjects' });
            }
        } else if (exam_type === 'Midterm' && (!midterm_max_marks || parseInt(midterm_max_marks) <= 0)) {
            return res.status(400).json({ error: 'Max marks for midterm is required when adding subjects' });
        } else if (exam_type === 'Final' && (!final_max_marks || parseInt(final_max_marks) <= 0)) {
            return res.status(400).json({ error: 'Max marks for final is required when adding subjects' });
        }
    }
    
    // Handle subjects structure - can be array or object { midterm: [...], final: [...] }
    let totalMarks = 0;
    let maxMarks = 100;
    let grade = 'N/A';
    let finalSubjectsToStore = subjectsParsed;
    
    // If exam_type is "Both" and subjects is an object with midterm/final
    if (exam_type === 'Both' && subjectsParsed && typeof subjectsParsed === 'object' && !Array.isArray(subjectsParsed)) {
        // Calculate total from both midterm and final
        const midtermSubjects = subjectsParsed.midterm || [];
        const finalSubjects = subjectsParsed.final || [];
        const validMidterm = midtermSubjects.filter(s => s.name && s.name.trim() !== '');
        const validFinal = finalSubjects.filter(s => s.name && s.name.trim() !== '');
        const allSubjects = [...validMidterm, ...validFinal];
        
        if (allSubjects.length > 0) {
            totalMarks = allSubjects.reduce((sum, s) => sum + (parseFloat(s.mark) || 0), 0);
            // Calculate max marks: midterm subjects * midtermMax + final subjects * finalMax
            maxMarks = (validMidterm.length * midtermMax) + (validFinal.length * finalMax);
            grade = calculateGrade(totalMarks, maxMarks);
        }
        finalSubjectsToStore = subjectsParsed; // Keep object structure
    } else if (Array.isArray(subjectsParsed)) {
        // Handle array format (Midterm or Final only, or old format)
        const validSubjects = subjectsParsed.filter(s => s.name && s.name.trim() !== '');
        if (validSubjects.length > 0) {
            totalMarks = validSubjects.reduce((sum, s) => sum + (parseFloat(s.mark) || 0), 0);
            // Use appropriate max marks based on exam type
            const currentMax = exam_type === 'Midterm' ? midtermMax : finalMax;
            maxMarks = validSubjects.length * currentMax;
            grade = calculateGrade(totalMarks, maxMarks);
        }
        finalSubjectsToStore = validSubjects;
    }

    let updateQuery = `UPDATE students SET student_name = ?, id_number = ?, exam_type = ?, level = ?, exam_link = ?,
                       subjects_json = ?, total_marks = ?, grade = ?, exam_date = ?`;
    let params = [student_name, id_number, exam_type, level || null, exam_link || null, JSON.stringify(finalSubjectsToStore), totalMarks, grade, exam_date];

    if (req.file) {
        updateQuery += ', photo_url = ?';
        params.push(`/uploads/photos/${req.file.filename}`);
    }

    updateQuery += ' WHERE id = ?';
    params.push(studentId);

    // Get exam_number for QR code generation
    db.get("SELECT exam_number FROM students WHERE id = ?", [studentId], async (err, studentRow) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        
        if (!studentRow) {
            return res.status(404).json({ error: 'Student not found' });
        }
        
        db.run(updateQuery, params, async (err) => {
            if (err) {
                console.error('Update Error:', err);
                res.status(500).json({ error: err.message });
            } else {
                // Generate QR code for the updated student
                const qrUrl = `${req.protocol}://${req.get('host')}/result/${studentRow.exam_number}`;
                try {
                    const qrCodeData = await QRCode.toDataURL(qrUrl, {
                        errorCorrectionLevel: 'M',
                        type: 'image/png',
                        quality: 0.92,
                        margin: 1,
                        width: 300
                    });
                    res.json({ 
                        success: true, 
                        message: 'Student updated successfully',
                        student: {
                            id: studentId,
                            exam_number: studentRow.exam_number,
                            qr_code_data: qrCodeData,
                            qr_url: qrUrl
                        }
                    });
                } catch (qrErr) {
                    console.error('QR Code generation error:', qrErr);
                    res.json({ 
                        success: true, 
                        message: 'Student updated successfully',
                        student: {
                            id: studentId,
                            exam_number: studentRow.exam_number,
                            qr_url: qrUrl
                        }
                    });
                }
            }
        });
    });
});

// Delete student - MUST BE AFTER specific routes like /api/students/:id/qr
app.delete('/api/students/:id', (req, res) => {
    console.log('DELETE route hit for student ID:', req.params.id); // Debug log
    const studentId = req.params.id;
    
    // First check if student exists
    db.get("SELECT id FROM students WHERE id = ?", [studentId], (err, row) => {
        if (err) {
            console.error('Delete Check Error:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
        
        if (!row) {
            console.log('Student not found for deletion:', studentId);
            return res.status(404).json({ success: false, error: 'Student not found' });
        }
        
        // Delete the student
        db.run("DELETE FROM students WHERE id = ?", [studentId], function(deleteErr) {
            if (deleteErr) {
                console.error('Delete Error:', deleteErr);
                return res.status(500).json({ success: false, error: deleteErr.message });
            }
            
            console.log('Student deleted successfully:', studentId);
            res.json({ 
                success: true, 
                message: 'Student deleted successfully',
                deletedId: studentId
            });
        });
    });
});

// Publish all students
app.post('/api/students/publish-all', (req, res) => {
    db.run("UPDATE students SET published = 1", [], function(err) {
        if (err) {
            console.error('Publish All Error:', err);
            res.status(500).json({ error: err.message });
        } else {
            res.json({ success: true, message: `All students published (${this.changes} updated)` });
        }
    });
});

// Export CSV
app.get('/api/students/export', (req, res) => {
    db.all("SELECT * FROM students ORDER BY created_at DESC", [], (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
        } else {
            const csv = [
                ['ID Number', 'Exam Number', 'Name', 'Exam Type', 'Subjects', 'Total Marks', 'Grade', 'Exam Date'].join(','),
                ...rows.map(row => {
                    const subjects = JSON.parse(row.subjects_json);
                    const subjectsStr = subjects.map(s => `${s.name}: ${s.mark}`).join('; ');
                    return [
                        row.id_number,
                        row.exam_number,
                        `"${row.student_name}"`,
                        row.exam_type,
                        `"${subjectsStr}"`,
                        row.total_marks,
                        row.grade,
                        row.exam_date
                    ].join(',');
                })
            ].join('\n');

            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename=students_export_${Date.now()}.csv`);
            res.send(csv);
        }
    });
});

// Admin login
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    const bcrypt = require('bcryptjs');
    
    db.get("SELECT * FROM admins WHERE username = ?", [username], (err, row) => {
        if (err) {
            res.status(500).json({ error: err.message });
        } else if (!row) {
            res.status(401).json({ error: 'Invalid credentials' });
        } else {
            if (bcrypt.compareSync(password, row.password_hash)) {
                res.json({ success: true, message: 'Login successful', admin: { id: row.id, username: row.username } });
            } else {
                res.status(401).json({ error: 'Invalid credentials' });
            }
        }
    });
});

// Get current admin info (requires login - simple check)
app.get('/api/admin/info', (req, res) => {
    // This is a simple endpoint - in production, you'd use proper session/auth middleware
    db.all("SELECT id, username, created_at FROM admins ORDER BY created_at ASC", [], (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
        } else {
            res.json({ success: true, admins: rows });
        }
    });
});

// Update admin password - must be before any catch-all middleware
app.put('/api/admin/password', (req, res) => {
    console.log('[ROUTE] PUT /api/admin/password MATCHED');
    console.log('[ROUTE] Request path:', req.path);
    console.log('[ROUTE] Request originalUrl:', req.originalUrl);
    console.log('[ROUTE] Request body:', { username: req.body?.username, hasPassword: !!req.body?.currentPassword, hasNewPassword: !!req.body?.newPassword });
    const { username, currentPassword, newPassword } = req.body;
    const bcrypt = require('bcryptjs');
    
    if (!username || !currentPassword || !newPassword) {
        return res.status(400).json({ error: 'Username, current password, and new password are required' });
    }
    
    if (newPassword.length < 6) {
        return res.status(400).json({ error: 'New password must be at least 6 characters long' });
    }
    
    db.get("SELECT * FROM admins WHERE username = ?", [username], (err, row) => {
        if (err) {
            res.status(500).json({ error: err.message });
        } else if (!row) {
            res.status(404).json({ error: 'Admin not found' });
        } else {
            // Verify current password
            if (bcrypt.compareSync(currentPassword, row.password_hash)) {
                // Hash new password
                const newHash = bcrypt.hashSync(newPassword, 10);
                db.run("UPDATE admins SET password_hash = ? WHERE username = ?", [newHash, username], (updateErr) => {
                    if (updateErr) {
                        res.status(500).json({ error: updateErr.message });
                    } else {
                        res.json({ success: true, message: 'Password updated successfully' });
                    }
                });
            } else {
                res.status(401).json({ error: 'Current password is incorrect' });
            }
        }
    });
});

// Update admin username - must be before any catch-all middleware
app.put('/api/admin/username', (req, res) => {
    console.log('[ROUTE] PUT /api/admin/username MATCHED');
    console.log('[ROUTE] Request path:', req.path);
    console.log('[ROUTE] Request originalUrl:', req.originalUrl);
    console.log('[ROUTE] Request body:', { currentUsername: req.body?.currentUsername, newUsername: req.body?.newUsername, hasPassword: !!req.body?.password });
    const { currentUsername, newUsername, password } = req.body;
    const bcrypt = require('bcryptjs');
    
    if (!currentUsername || !newUsername || !password) {
        return res.status(400).json({ error: 'Current username, new username, and password are required' });
    }
    
    if (newUsername.length < 3) {
        return res.status(400).json({ error: 'New username must be at least 3 characters long' });
    }
    
    db.get("SELECT * FROM admins WHERE username = ?", [currentUsername], (err, row) => {
        if (err) {
            res.status(500).json({ error: err.message });
        } else if (!row) {
            res.status(404).json({ error: 'Admin not found' });
        } else {
            // Verify password
            if (bcrypt.compareSync(password, row.password_hash)) {
                // Check if new username already exists
                db.get("SELECT * FROM admins WHERE username = ?", [newUsername], (checkErr, checkRow) => {
                    if (checkErr) {
                        res.status(500).json({ error: checkErr.message });
                    } else if (checkRow) {
                        res.status(400).json({ error: 'Username already exists' });
                    } else {
                        db.run("UPDATE admins SET username = ? WHERE username = ?", [newUsername, currentUsername], (updateErr) => {
                            if (updateErr) {
                                res.status(500).json({ error: updateErr.message });
                            } else {
                                res.json({ success: true, message: 'Username updated successfully', newUsername: newUsername });
                            }
                        });
                    }
                });
            } else {
                res.status(401).json({ error: 'Password is incorrect' });
            }
        }
    });
});

// Handle 404 for API routes - This will ONLY catch routes that weren't matched by app.put(), app.post(), etc.
// Express matches specific routes (app.put, app.post) BEFORE middleware (app.use), so this is safe
app.use((req, res, next) => {
    // Only handle API routes that weren't matched by previous routes
    if (req.path && req.path.startsWith('/api/')) {
        // Log full request details for debugging
        console.log(`[404] API endpoint not found: ${req.method} ${req.path || '(empty)'}`);
        console.log(`[404] Full URL: ${req.protocol}://${req.get('host')}${req.originalUrl || req.url}`);
        console.log(`[404] Original URL: ${req.originalUrl || req.url}`);
        console.log(`[404] Route was not matched by any app.put() or app.post() handler`);
        return res.status(404).json({ 
            success: false, 
            error: `API endpoint not found: ${req.method} ${req.path || '/'}` 
        });
    }
    next();
});

// Handle any other PUT/POST/DELETE requests to non-API routes
app.use((req, res, next) => {
    if (req.method !== 'GET' && !req.path.startsWith('/api/')) {
        console.log(`[404] Unhandled ${req.method} request to: ${req.path}`);
        console.log(`[404] Original URL: ${req.originalUrl}`);
        console.log(`[404] Full URL: ${req.protocol}://${req.get('host')}${req.originalUrl}`);
        res.status(404).json({ 
            success: false, 
            error: `Endpoint not found: ${req.method} ${req.path}` 
        });
    } else {
        next();
    }
});

// Keep-alive endpoint for uptime monitoring (Replit, UptimeRobot, etc.)
app.get('/keep-alive', (req, res) => {
    res.status(200).json({ 
        status: 'alive', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString()
    });
});

// Serve React app for all other routes (must be last)
app.get('*', (req, res, next) => {
    // Don't serve HTML for API routes or static files
    if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) {
        return next();
    }
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Keep-alive endpoint: http://localhost:${PORT}/keep-alive`);
});

