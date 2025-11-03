from flask import Flask, render_template, request, jsonify, send_file, session, redirect, url_for, flash
from flask_sqlalchemy import SQLAlchemy
from werkzeug.utils import secure_filename
from werkzeug.security import generate_password_hash, check_password_hash
import json
import csv
import io
import os
from datetime import datetime
import qrcode
from io import BytesIO
import base64

app = Flask(__name__)
app.config['SECRET_KEY'] = 'exam-results-secret-key-2025-change-in-production'
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///students.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['UPLOAD_FOLDER'] = 'uploads/photos'
app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024  # 16MB max file size

db = SQLAlchemy(app)

# Ensure upload folder exists
os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)

# Allowed file extensions
ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg', 'gif', 'webp'}

def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

# Database Models
class Admin(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    password_hash = db.Column(db.String(200), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

class Student(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    id_number = db.Column(db.String(50), nullable=False, index=True)
    exam_number = db.Column(db.String(50), unique=True, nullable=False, index=True)
    student_name = db.Column(db.String(200), nullable=False)
    photo_url = db.Column(db.String(500))
    exam_type = db.Column(db.String(20), nullable=False)  # Midterm, Final, Both
    subjects_json = db.Column(db.Text, nullable=False)  # JSON array of subjects
    total_marks = db.Column(db.Float, nullable=False)
    grade = db.Column(db.String(2), nullable=False)
    exam_date = db.Column(db.Date, nullable=False, default=datetime.utcnow)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    def to_dict(self):
        return {
            'id': self.id,
            'id_number': self.id_number,
            'exam_number': self.exam_number,
            'student_name': self.student_name,
            'photo_url': self.photo_url or 'https://via.placeholder.com/150?text=Student',
            'exam_type': self.exam_type,
            'subjects': json.loads(self.subjects_json) if self.subjects_json else [],
            'total_marks': self.total_marks,
            'grade': self.grade,
            'exam_date': self.exam_date.strftime('%Y-%m-%d') if self.exam_date else None,
            'created_at': self.created_at.strftime('%Y-%m-%d %H:%M:%S') if self.created_at else None
        }

# Initialize database and create default admin
with app.app_context():
    db.create_all()
    # Create default admin if not exists
    if not Admin.query.first():
        default_admin = Admin(
            username='admin',
            password_hash=generate_password_hash('admin123')
        )
        db.session.add(default_admin)
        db.session.commit()

# Helper Functions
def calculate_grade(total_marks, max_marks=100):
    """Calculate grade based on percentage"""
    if max_marks == 0:
        return 'F'
    percentage = (total_marks / max_marks) * 100
    if percentage >= 90:
        return 'A'
    elif percentage >= 80:
        return 'B'
    elif percentage >= 70:
        return 'C'
    elif percentage >= 60:
        return 'D'
    else:
        return 'F'

def generate_exam_number():
    """Auto-generate exam number"""
    year = datetime.now().year
    last_student = Student.query.order_by(Student.id.desc()).first()
    if last_student:
        try:
            last_num = int(last_student.exam_number.split('-')[-1])
            new_num = last_num + 1
        except:
            new_num = 1
    else:
        new_num = 1
    return f"EX-{year}-{new_num:03d}"

def generate_qr_code(data):
    """Generate QR code and return as base64"""
    qr = qrcode.QRCode(version=1, box_size=10, border=5)
    qr.add_data(data)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white")
    buffered = BytesIO()
    img.save(buffered, format="PNG")
    img_str = base64.b64encode(buffered.getvalue()).decode()
    return f"data:image/png;base64,{img_str}"

def login_required(f):
    """Decorator for login required routes"""
    def decorated_function(*args, **kwargs):
        if 'admin_logged_in' not in session:
            return redirect(url_for('admin_login'))
        return f(*args, **kwargs)
    decorated_function.__name__ = f.__name__
    return decorated_function

# Routes
@app.route('/')
def index():
    """Public result page"""
    exam_number = request.args.get('exam', '').strip()
    return render_template('result.html', exam_number=exam_number)

@app.route('/admin/login', methods=['GET', 'POST'])
def admin_login():
    """Admin login page"""
    if request.method == 'POST':
        username = request.form.get('username', '').strip()
        password = request.form.get('password', '').strip()
        
        admin = Admin.query.filter_by(username=username).first()
        
        if admin and check_password_hash(admin.password_hash, password):
            session['admin_logged_in'] = True
            session['admin_username'] = username
            return redirect(url_for('admin_dashboard'))
        else:
            flash('Invalid username or password', 'error')
    
    return render_template('admin_login.html')

@app.route('/admin/logout')
def admin_logout():
    """Admin logout"""
    session.pop('admin_logged_in', None)
    session.pop('admin_username', None)
    return redirect(url_for('admin_login'))

@app.route('/admin')
@login_required
def admin_dashboard():
    """Admin dashboard"""
    return render_template('admin.html')

# API Routes
@app.route('/api/admin/login', methods=['POST'])
def api_admin_login():
    """API endpoint for admin login"""
    data = request.get_json()
    username = data.get('username', '').strip()
    password = data.get('password', '').strip()
    
    admin = Admin.query.filter_by(username=username).first()
    
    if admin and check_password_hash(admin.password_hash, password):
        session['admin_logged_in'] = True
        session['admin_username'] = username
        return jsonify({'success': True, 'message': 'Login successful'})
    else:
        return jsonify({'success': False, 'message': 'Invalid credentials'}), 401

@app.route('/api/students', methods=['GET'])
@login_required
def get_all_students():
    """Get all students (admin only)"""
    students = Student.query.order_by(Student.created_at.desc()).all()
    return jsonify([student.to_dict() for student in students])

@app.route('/api/result/<exam_number>', methods=['GET'])
def get_student_result(exam_number):
    """Get student result by exam number (public)"""
    student = Student.query.filter_by(exam_number=exam_number).first()
    
    if not student:
        return jsonify({'success': False, 'error': 'Student not found'}), 404
    
    result = student.to_dict()
    
    # Generate QR code URL
    base_url = request.url_root.rstrip('/')
    qr_url = f"{base_url}/?exam={exam_number}"
    result['qr_url'] = qr_url
    result['qr_code_data'] = generate_qr_code(qr_url)
    
    return jsonify({'success': True, 'student': result})

@app.route('/api/result', methods=['GET'])
def get_result_by_query():
    """Get result by exam number from query parameter"""
    exam_number = request.args.get('exam', '').strip()
    if not exam_number:
        return jsonify({'success': False, 'error': 'Exam number required'}), 400
    
    student = Student.query.filter_by(exam_number=exam_number).first()
    
    if not student:
        return jsonify({'success': False, 'error': 'Student not found'}), 404
    
    result = student.to_dict()
    base_url = request.url_root.rstrip('/')
    qr_url = f"{base_url}/?exam={exam_number}"
    result['qr_url'] = qr_url
    result['qr_code_data'] = generate_qr_code(qr_url)
    
    return jsonify({'success': True, 'student': result})

@app.route('/api/students/add', methods=['POST'])
@login_required
def add_student():
    """Add new student"""
    try:
        # Handle both FormData and JSON
        if request.content_type and 'multipart/form-data' in request.content_type:
            # FormData (file upload)
            student_name = request.form.get('student_name', '').strip()
            id_number = request.form.get('id_number', '').strip()
            exam_number = request.form.get('exam_number', '').strip() or generate_exam_number()
            exam_type = request.form.get('exam_type', 'Both').strip()
            subjects_json = request.form.get('subjects', '[]')
            subjects = json.loads(subjects_json) if subjects_json else []
            exam_date = request.form.get('exam_date', datetime.now().strftime('%Y-%m-%d'))
            photo_url = ''
            
            # Handle photo upload
            if 'photo' in request.files:
                file = request.files['photo']
                if file and file.filename and allowed_file(file.filename):
                    filename = secure_filename(f"{id_number}_{int(datetime.now().timestamp())}.{file.filename.rsplit('.', 1)[1].lower()}")
                    filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)
                    file.save(filepath)
                    photo_url = url_for('uploaded_file', filename=filename, _external=True)
        else:
            # JSON (backward compatibility)
            data = request.get_json()
            student_name = data.get('student_name', '').strip()
            id_number = data.get('id_number', '').strip()
            exam_number = data.get('exam_number', '').strip() or generate_exam_number()
            exam_type = data.get('exam_type', 'Both').strip()
            subjects = data.get('subjects', [])
            photo_url = data.get('photo_url', '').strip()
            exam_date = data.get('exam_date', datetime.now().strftime('%Y-%m-%d'))
        
        # Validation
        if not student_name or not id_number:
            return jsonify({'success': False, 'error': 'Name and ID are required'}), 400
        
        if not subjects or len(subjects) == 0:
            return jsonify({'success': False, 'error': 'At least one subject is required'}), 400
        
        # Check if exam number already exists
        if Student.query.filter_by(exam_number=exam_number).first():
            return jsonify({'success': False, 'error': 'Exam number already exists'}), 400
        
        # Calculate total marks
        total_marks = sum(float(subject.get('mark', 0)) for subject in subjects)
        max_marks = len(subjects) * 100  # Assuming 100 is max per subject
        grade = calculate_grade(total_marks, max_marks)
        
        # Use default photo if none provided
        if not photo_url:
            photo_url = 'https://via.placeholder.com/150?text=Student'
        
        # Create student record
        new_student = Student(
            id_number=id_number,
            exam_number=exam_number,
            student_name=student_name,
            photo_url=photo_url or 'https://via.placeholder.com/150?text=Student',
            exam_type=exam_type,
            subjects_json=json.dumps(subjects),
            total_marks=total_marks,
            grade=grade,
            exam_date=datetime.strptime(exam_date, '%Y-%m-%d').date() if exam_date else datetime.now().date()
        )
        
        db.session.add(new_student)
        db.session.commit()
        
        result = new_student.to_dict()
        base_url = request.url_root.rstrip('/')
        qr_url = f"{base_url}/?exam={exam_number}"
        result['qr_url'] = qr_url
        result['qr_code_data'] = generate_qr_code(qr_url)
        
        return jsonify({'success': True, 'message': 'Student added successfully', 'student': result})
        
    except Exception as e:
        db.session.rollback()
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/students/<int:student_id>', methods=['PUT'])
@login_required
def update_student(student_id):
    """Update student record"""
    try:
        student = Student.query.get_or_404(student_id)
        data = request.get_json()
        
        student.student_name = data.get('student_name', student.student_name).strip()
        student.id_number = data.get('id_number', student.id_number).strip()
        student.exam_type = data.get('exam_type', student.exam_type).strip()
        subjects = data.get('subjects', [])
        
        if subjects:
            student.subjects_json = json.dumps(subjects)
            total_marks = sum(float(s.get('mark', 0)) for s in subjects)
            max_marks = len(subjects) * 100
            student.total_marks = total_marks
            student.grade = calculate_grade(total_marks, max_marks)
        
        if data.get('photo_url'):
            student.photo_url = data.get('photo_url').strip()
        
        if data.get('exam_date'):
            student.exam_date = datetime.strptime(data.get('exam_date'), '%Y-%m-%d').date()
        
        db.session.commit()
        
        return jsonify({'success': True, 'message': 'Student updated successfully', 'student': student.to_dict()})
        
    except Exception as e:
        db.session.rollback()
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/students/<int:student_id>', methods=['DELETE'])
@login_required
def delete_student(student_id):
    """Delete student record"""
    try:
        student = Student.query.get_or_404(student_id)
        db.session.delete(student)
        db.session.commit()
        return jsonify({'success': True, 'message': 'Student deleted successfully'})
    except Exception as e:
        db.session.rollback()
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/students/export', methods=['GET'])
@login_required
def export_students():
    """Export students to CSV"""
    students = Student.query.all()
    
    output = io.StringIO()
    writer = csv.writer(output)
    
    # Write header
    writer.writerow(['ID Number', 'Exam Number', 'Name', 'Exam Type', 'Subjects', 'Total Marks', 'Grade', 'Exam Date'])
    
    # Write data
    for student in students:
        subjects_str = ', '.join([f"{s['name']}: {s['mark']}" for s in json.loads(student.subjects_json)])
        writer.writerow([
            student.id_number,
            student.exam_number,
            student.student_name,
            student.exam_type,
            subjects_str,
            student.total_marks,
            student.grade,
            student.exam_date.strftime('%Y-%m-%d') if student.exam_date else ''
        ])
    
    output.seek(0)
    return send_file(
        io.BytesIO(output.getvalue().encode('utf-8')),
        mimetype='text/csv',
        as_attachment=True,
        download_name=f'students_export_{datetime.now().strftime("%Y%m%d")}.csv'
    )

@app.route('/uploads/photos/<filename>')
def uploaded_file(filename):
    """Serve uploaded photos"""
    return send_file(os.path.join(app.config['UPLOAD_FOLDER'], filename))

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000)
