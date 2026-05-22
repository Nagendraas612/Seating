# AIML Internal Examination Seat Allotment System

A smart and automated **Examination Seating Arrangement System** developed for the **Department of Artificial Intelligence & Machine Learning (AIML)** to simplify internal exam seating allocation, generate seating layouts, attendance sheets, and notice board summaries.

---

# ✨ Features

## 🔐 Google Authentication

* Secure login using Google OAuth
* Session-based authentication
* Protected admin routes

---

## 🏫 Room Management

* Add / Edit / Delete rooms
* Enable or disable rooms
* Configure bench count dynamically

---

## 📂 Excel Upload Support

Upload semester-wise student lists using:

* `.xlsx`
* `.xls`
* `.csv`

Expected columns:

* Name
* USN

---

## 🧠 Smart Seating Algorithm

### Features:

✅ Maintains USN order
✅ Anti-copy seating pattern
✅ Alternating room patterns
✅ Automatic overflow handling
✅ Dynamic room allocation

---

## 🪑 Seating Logic

Each bench contains:

```text
LEFT | MIDDLE | RIGHT
```

Allowed patterns:

```text
A B A
B A B
```

---

## 🔄 Room Alternation

### Room 1

```text
ABA
BAB
ABA
```

### Room 2

```text
BAB
ABA
BAB
```

### Room 3

```text
ABA
BAB
ABA
```

This ensures:

* adjacent students are from different semesters
* copying chances are minimized

---

# 📄 PDF Generation

The system automatically generates:

## ✅ Seating Layout PDF

Detailed classroom-wise seating arrangement.

## ✅ Attendance Sheet PDF

Sorted attendance sheets with signature columns.

## ✅ Notice Board PDF

Room allocation summary with USN ranges.

---

# 🛠️ Tech Stack

## Frontend

* HTML
* CSS
* JavaScript

## Backend

* Node.js
* Express.js

## Database

* MongoDB Atlas

## Authentication

* Passport.js
* Google OAuth 2.0

## Other Libraries

* PDFKit
* XLSX
* Multer
* Express Session
* Connect Mongo

---

# 📁 Project Structure

```text
Seating/
│
├── backend/
│   ├── server.js
│   ├── package.json
│   ├── .env
│   └── node_modules/
│
├── frontend/
│   ├── index.html
│   ├── style.css
│   └── script.js
│
└── README.md
```

---

# ⚙️ Installation & Setup

## 1️⃣ Clone Repository

```bash
git clone YOUR_GITHUB_REPO_LINK
cd Seating
```

---

## 2️⃣ Install Backend Dependencies

```bash
cd backend
npm install
```

---

## 3️⃣ Create `.env`

Inside `backend/.env`

```env
PORT=5000

MONGO_URI=YOUR_MONGODB_URI

SESSION_SECRET=your_secret_key

GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret

GOOGLE_CALLBACK_URL=http://localhost:5000/auth/google/callback

FRONTEND_URL=http://localhost:5000
```

---

# ▶️ Run Locally

## Start Backend

```bash
cd backend
node server.js
```

OR (recommended)

```bash
nodemon server.js
```

---

# 🌐 Open in Browser

```text
http://localhost:5000
```

---

# 🧪 Local Testing Workflow

Instead of deploying after every change:

✅ Run locally
✅ Test PDFs locally
✅ Check browser console (`F12`)
✅ Check backend logs
✅ Push only after everything works

---

# 🚀 Deployment

Recommended platforms:

* Render
* Railway
* Cyclic
* Vercel (frontend)

---

# 📌 Environment Variables for Deployment

```env
FRONTEND_URL=https://your-deployed-url.onrender.com
GOOGLE_CALLBACK_URL=https://your-deployed-url.onrender.com/auth/google/callback
```

---

# 📷 System Modules

* Google Login
* Room Management
* Excel Upload
* Seating Generator
* Seating PDF
* Attendance PDF
* Notice Board PDF
* Allocation History

---

# 🎯 Future Improvements

* Drag & Drop seating
* Faculty allocation
* Hall ticket integration
* QR attendance
* Export to Excel
* Dark mode UI
* AI-based cheating prevention analytics

---

# 👨‍💻 Developed By

**Nagendra AS (Sanjay)**
Artificial Intelligence & Machine Learning
VVCE Mysuru

---

# 📜 License

This project is developed for educational and institutional use.
