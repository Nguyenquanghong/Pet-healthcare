-- ==============================================================================
-- NIPONETO DATABASE SCHEMA (PostgreSQL / MySQL compatible)
-- Bệnh viện Thú y & Khách sạn Thú cưng Nippon Pet Care
-- ==============================================================================

-- 1. BẢNG USERS / AUTH (Tài khoản người dùng & Phân quyền)
CREATE TABLE users (
    id VARCHAR(64) PRIMARY KEY,
    username VARCHAR(100) UNIQUE,
    phone VARCHAR(20) UNIQUE NOT NULL,
    email VARCHAR(150) UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    password_salt VARCHAR(255) NOT NULL,
    full_name VARCHAR(150) NOT NULL,
    role VARCHAR(30) NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'doctor', 'staff', 'admin')),
    address TEXT,
    avatar_url TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_users_phone ON users(phone);
CREATE INDEX idx_users_role ON users(role);

-- 2. BẢNG PETS (Hồ sơ Thú cưng)
CREATE TABLE pets (
    id VARCHAR(64) PRIMARY KEY,
    owner_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    species VARCHAR(30) NOT NULL CHECK (species IN ('dog', 'cat', 'rabbit', 'other')),
    breed VARCHAR(100),
    gender VARCHAR(20) DEFAULT 'unknown' CHECK (gender IN ('male', 'female', 'unknown')),
    age_label VARCHAR(50),
    weight_kg NUMERIC(5, 2),
    microchip_id VARCHAR(100) UNIQUE,
    health_status VARCHAR(50) DEFAULT 'healthy' CHECK (health_status IN ('healthy', 'stable', 'vaccination_due', 'under_treatment', 'critical')),
    allergies TEXT[], -- Danh sách dị ứng (PostgreSQL array hoặc JSON trong MySQL)
    notes TEXT,
    avatar_url TEXT,
    qr_token VARCHAR(255) UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_pets_owner ON pets(owner_id);
CREATE INDEX idx_pets_microchip ON pets(microchip_id);

-- 3. BẢNG APPOINTMENTS (Lịch khám & Dịch vụ)
CREATE TABLE appointments (
    id VARCHAR(64) PRIMARY KEY,
    pet_id VARCHAR(64) NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
    owner_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    doctor_id VARCHAR(64) REFERENCES users(id) ON DELETE SET NULL,
    type VARCHAR(50) NOT NULL CHECK (type IN ('general_checkup', 'vaccination', 'dermatology', 'surgery', 'emergency', 'grooming')),
    service_name VARCHAR(150) NOT NULL,
    clinic_name VARCHAR(150) DEFAULT 'Bệnh viện Thú y Mỹ Đình',
    appointment_date DATE NOT NULL,
    appointment_time VARCHAR(10) NOT NULL, -- HH:mm
    status VARCHAR(30) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'checked_in', 'in_progress', 'completed', 'cancelled', 'no_show')),
    owner_note TEXT,
    internal_note TEXT,
    created_by VARCHAR(30) DEFAULT 'owner',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_appointments_pet ON appointments(pet_id);
CREATE INDEX idx_appointments_owner ON appointments(owner_id);
CREATE INDEX idx_appointments_date ON appointments(appointment_date);
CREATE INDEX idx_appointments_status ON appointments(status);

-- 4. BẢNG MEDICAL_RECORDS (Hồ sơ Bệnh án Điện tử)
CREATE TABLE medical_records (
    id VARCHAR(64) PRIMARY KEY,
    pet_id VARCHAR(64) NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
    owner_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    appointment_id VARCHAR(64) REFERENCES appointments(id) ON DELETE SET NULL,
    doctor_name VARCHAR(150) NOT NULL,
    visit_date DATE NOT NULL,
    title VARCHAR(200) NOT NULL,
    symptoms TEXT,
    diagnosis TEXT,
    treatment TEXT,
    medications TEXT,
    vaccine_name VARCHAR(150),
    follow_up_date DATE,
    weight_kg NUMERIC(5, 2),
    temperature_c NUMERIC(4, 1),
    heart_rate_bpm INTEGER,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_medical_records_pet ON medical_records(pet_id);
CREATE INDEX idx_medical_records_date ON medical_records(visit_date);

-- 5. BẢNG HOTEL_BOOKINGS (Lưu trú Khách sạn Thú cưng)
CREATE TABLE hotel_bookings (
    id VARCHAR(64) PRIMARY KEY,
    pet_id VARCHAR(64) NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
    owner_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    check_in DATE NOT NULL,
    check_out DATE NOT NULL,
    nights INTEGER NOT NULL,
    room_type VARCHAR(30) NOT NULL CHECK (room_type IN ('standard', 'deluxe', 'vip')),
    service_keys TEXT[], -- ['daily_walk', 'special_diet', 'webcam_access', 'spa_grooming']
    total_amount NUMERIC(12, 2) NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'in_stay', 'checked_out', 'cancelled', 'rejected')),
    owner_note TEXT,
    internal_note TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_hotel_bookings_pet ON hotel_bookings(pet_id);
CREATE INDEX idx_hotel_bookings_owner ON hotel_bookings(owner_id);
CREATE INDEX idx_hotel_bookings_dates ON hotel_bookings(check_in, check_out);

-- 6. BẢNG DAILY_CARE_NOTES (Nhật ký Chăm sóc Hàng ngày tại Khách sạn)
CREATE TABLE daily_care_notes (
    id VARCHAR(64) PRIMARY KEY,
    booking_id VARCHAR(64) NOT NULL REFERENCES hotel_bookings(id) ON DELETE CASCADE,
    note_date DATE NOT NULL,
    eating_status VARCHAR(20) DEFAULT 'normal' CHECK (eating_status IN ('good', 'normal', 'poor')),
    mood VARCHAR(20) DEFAULT 'calm' CHECK (mood IN ('happy', 'calm', 'anxious', 'tired')),
    note TEXT NOT NULL,
    visible_to_owner BOOLEAN DEFAULT TRUE,
    created_by_staff_id VARCHAR(64) REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_care_notes_booking ON daily_care_notes(booking_id);

-- 7. BẢNG NOTIFICATIONS (Hệ thống Thông báo 2 chiều)
CREATE TABLE notifications (
    id VARCHAR(64) PRIMARY KEY,
    recipient_owner_id VARCHAR(64) REFERENCES users(id) ON DELETE CASCADE,
    recipient_role VARCHAR(20) DEFAULT 'owner' CHECK (recipient_role IN ('owner', 'admin')),
    type VARCHAR(50) NOT NULL,
    title VARCHAR(200) NOT NULL,
    message TEXT NOT NULL,
    status VARCHAR(20) DEFAULT 'sent' CHECK (status IN ('sent', 'read', 'archived')),
    action_url VARCHAR(255),
    related_pet_id VARCHAR(64) REFERENCES pets(id) ON DELETE SET NULL,
    related_appointment_id VARCHAR(64) REFERENCES appointments(id) ON DELETE SET NULL,
    related_booking_id VARCHAR(64) REFERENCES hotel_bookings(id) ON DELETE SET NULL,
    sent_by_staff_id VARCHAR(64) REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    sent_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_notifications_recipient ON notifications(recipient_owner_id, recipient_role, status);

-- 8. BẢNG INVOICES (Hóa đơn Dịch vụ & Thanh toán)
CREATE TABLE invoices (
    id VARCHAR(64) PRIMARY KEY,
    invoice_code VARCHAR(50) UNIQUE NOT NULL,
    type VARCHAR(30) NOT NULL CHECK (type IN ('appointment', 'hotel_booking', 'store')),
    owner_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    pet_id VARCHAR(64) NOT NULL REFERENCES pets(id) ON DELETE RESTRICT,
    appointment_id VARCHAR(64) REFERENCES appointments(id) ON DELETE SET NULL,
    hotel_booking_id VARCHAR(64) REFERENCES hotel_bookings(id) ON DELETE SET NULL,
    subtotal NUMERIC(12, 2) NOT NULL,
    tax_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
    discount_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
    total_amount NUMERIC(12, 2) NOT NULL,
    payment_status VARCHAR(20) NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('paid', 'unpaid', 'refunded')),
    payment_method VARCHAR(30) CHECK (payment_method IN ('cash', 'bank_transfer', 'credit_card', 'qr_code')),
    issued_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    paid_at TIMESTAMP WITH TIME ZONE,
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_invoices_owner ON invoices(owner_id);
CREATE INDEX idx_invoices_code ON invoices(invoice_code);
CREATE INDEX idx_invoices_status ON invoices(payment_status);

-- 9. BẢNG INVOICE_ITEMS (Chi tiết Hóa đơn)
CREATE TABLE invoice_items (
    id VARCHAR(64) PRIMARY KEY,
    invoice_id VARCHAR(64) NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    description VARCHAR(255) NOT NULL,
    unit_price NUMERIC(12, 2) NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    amount NUMERIC(12, 2) NOT NULL
);

CREATE INDEX idx_invoice_items_invoice ON invoice_items(invoice_id);
