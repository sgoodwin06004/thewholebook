# The Whole Book

A book review management system for tracking professional reviews and rated reports. Built with vanilla HTML/JS, Supabase, and deployed on Vercel.

## Overview

The Whole Book allows a team of reviewers to submit book data, professional reviews, and rated reports through a structured intake form. Admins can manage users and assign roles from a protected dashboard.

## Features

- **Role-based access** — Admins and Reviewers with different permissions
- **Book intake form** — Enter book details, rated report, and multiple professional reviews in one submission
- **User management** — Invite new users and assign roles from the admin dashboard
- **Row-level security** — Reviewers can only edit their own entries; admins can manage everything
- **Invite flow** — New users receive an email invite and set their own password

## Project Structure

```
/
├── login.html          # Login page (role-based redirect after sign in)
├── admin.html          # Admin dashboard (user list, role management, invite)
├── reviewer.html       # Book intake form (auth-protected)
├── api/
│   └── admin/
│       ├── users.js    # Serverless function — list all users + roles
│       ├── invite.js   # Serverless function — invite a new user
│       └── set-role.js # Serverless function — update a user's role
├── package.json        # Node dependencies (@supabase/supabase-js)
└── setup_roles.sql     # Supabase SQL — run once to set up tables and RLS
```

## Tech Stack

- **Frontend** — Vanilla HTML, CSS, JavaScript
- **Auth & Database** — [Supabase](https://supabase.com)
- **Hosting** — [Vercel](https://vercel.com)

## Database Schema

### `books`
| Column | Type |
|--------|------|
| id | uuid |
| title | text |
| author | text |
| isbn | text |
| cover_url | text |
| created_at | timestamp |

### `pro_reviews`
| Column | Type |
|--------|------|
| id | bigint |
| book_id | uuid → books.id |
| user_id | uuid → auth.users.id |
| source | text |
| summary | text |
| url | text |
| award | text |
| created_at | timestamp |

### `rated_reports`
| Column | Type |
|--------|------|
| id | uuid |
| book_id | uuid → books.id |
| user_id | uuid → auth.users.id |
| rating | smallint (1–5) |
| flagged_categories | text |
| excerpts | text |
| report_url | text |
| created_at | timestamp |

### `profiles`
| Column | Type |
|--------|------|
| id | uuid → auth.users.id |
| email | text |
| role | text (`admin` or `reviewer`) |
| created_at | timestamp |

## Setup

### 1. Supabase

1. Create a new project at [supabase.com](https://supabase.com)
2. Go to **SQL Editor** and run the contents of `setup_roles.sql`
3. Go to **Authentication → URL Configuration** and set:
   - **Site URL** → `https://your-project.vercel.app`
   - **Redirect URLs** → `https://your-project.vercel.app/login.html`
4. Go to **Settings → API** and copy:
   - Project URL
   - `anon` public key
   - `service_role` secret key

### 2. Environment Variables

In your **Vercel Dashboard → Settings → Environment Variables**, add:

| Key | Value |
|-----|-------|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_ANON_KEY` | Your anon/public key |
| `SUPABASE_SERVICE_ROLE_KEY` | Your service role secret key |

### 3. Frontend Config

In `login.html`, `admin.html`, and `reviewer.html`, replace:

```js
const SUPABASE_URL      = 'https://YOUR_PROJECT.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR_ANON_KEY';
```

### 4. First Admin User

1. Go to **Supabase → Authentication → Users → Invite user**
2. Enter your email and send the invite
3. Click the invite link in your email to set your password
4. Run this SQL to make yourself an admin:

```sql
insert into public.profiles (id, email, role)
values (
  (select id from auth.users where email = 'your@email.com'),
  'your@email.com',
  'admin'
)
on conflict (id) do update set role = 'admin';
```

## User Roles

| Role | Permissions |
|------|-------------|
| **Admin** | Full access — manage users, assign roles, view/edit all data |
| **Reviewer** | Can create, edit, and delete their own reviews only |

New users are assigned the `reviewer` role by default. Admins can promote users to `admin` from the dashboard.

## Deployment

The project deploys automatically to Vercel on every push to the `main` branch. The `api/` directory is served as Vercel serverless functions.

```bash
git add .
git commit -m "your message"
git push
```
