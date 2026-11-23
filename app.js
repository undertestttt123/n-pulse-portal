
/* =====================================================================
 * N-Pulse-AI — app.js (Supabase + Edge Function Connected)
 * ===================================================================== */

const SUPABASE_URL = 'https://jsnxswhycajkypmtoonk.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Impzbnhzd2h5Y2Fqa3lwbXRvb25rIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTUxOTg2NzAsImV4cCI6MjExMDc3NDY3MH0.XuXtBXhx2YtatPdCUfNltaFdwzmPPOkEM3iUCUs6_b0';
const STORAGE_BUCKET = 'report-images';

const SUPABASE_FUNCTION_URL =
  'https://sura209.app.n8n.cloud/webhook/employee-report-update';

const sb = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY
);

/* ---------------- Constants ---------------- */

const STATUS_LABELS = {
  'Pending': 'قيد الانتظار',
  'In Progress': 'قيد المعالجة',
  'Resolved': 'تم الحل'
};

const STATUS_CLASS = {
  'Pending': 'badge-pending',
  'In Progress': 'badge-progress',
  'Resolved': 'badge-resolved'
};

const PRIORITY_LABELS = {
  Urgent: 'عاجل',
  Normal: 'عادي'
};

const PRIORITY_CLASS = {
  Urgent: 'badge-urgent',
  Normal: 'badge-normal'
};

/* ---------------- Helpers ---------------- */

function resolveReportImage(report) {
  if (!report) return null;

  if (report.image_url) return report.image_url;

  if (!report.image_path) return null;

  if (
    /^https?:\/\//i.test(report.image_path) ||
    report.image_path.startsWith('data:image/')
  ) {
    return report.image_path;
  }

  const cleanPath = String(report.image_path).replace(/^\/+/, '');

  const { data } = sb.storage
    .from(STORAGE_BUCKET)
    .getPublicUrl(cleanPath);

  return data?.publicUrl || null;
}

function normalizeReport(row, fallbackDepartmentName = '') {
  const deptName =
    row.department ||
    row.departments?.name ||
    row.departments?.title ||
    fallbackDepartmentName ||
    '';

  return {
    ...row,
    department: deptName,
    department_id: row.department_id ?? row.departments?.id ?? null,
    phone: row.phone ?? row.phone_number ?? '',
    submitted_at: row.submitted_at || row.created_at || new Date().toISOString(),
    image_url: resolveReportImage(row),
    employee_reply: row.employee_reply ?? ''
  };
}

async function getEmployeeProfileByAuthId(authUserId, fallbackEmail = '') {
  let { data: emp, error } = await sb
    .from('employees')
    .select('*, departments(*)')
    .eq('auth_user_id', authUserId)
    .maybeSingle();

  // Fallback إذا كان اسم عمود المستخدم user_id
  if (!emp && !error) {
    const resByUserId = await sb
      .from('employees')
      .select('*, departments(*)')
      .eq('user_id', authUserId)
      .maybeSingle();

    emp = resByUserId.data;
    error = resByUserId.error;
  }

  if (error || !emp) return null;

  let departmentName =
    emp.department ||
    emp.departments?.name ||
    emp.departments?.title ||
    '';

  const departmentId =
    emp.department_id ??
    emp.departments?.id ??
    null;

  if (
    !departmentName &&
    departmentId !== null &&
    departmentId !== undefined
  ) {
    const { data: dept } = await sb
      .from('departments')
      .select('*')
      .eq('id', departmentId)
      .maybeSingle();

    departmentName = dept?.name || dept?.title || '';
  }

  return {
    id: emp.id,
    auth_user_id: emp.auth_user_id || emp.user_id || authUserId,
    name: emp.full_name || emp.name || fallbackEmail,
    email: emp.email || fallbackEmail,
    department: departmentName,
    department_id: departmentId
  };
}

/* ---------------- DataService ---------------- */

const DataService = {

  init() {
    // لا نحتاج بيانات وهمية مع Supabase
  },

  async login(email, password) {
    const cleanEmail = String(email || '').trim().toLowerCase();

    const { data, error } = await sb.auth.signInWithPassword({
      email: cleanEmail,
      password
    });

    if (error || !data?.user) return null;

    const profile = await getEmployeeProfileByAuthId(
      data.user.id,
      data.user.email || cleanEmail
    );

    if (!profile) {
      await sb.auth.signOut();
      return null;
    }

    return profile;
  },

  async logout() {
    await sb.auth.signOut();
  },

  async getSession() {
    const { data, error } = await sb.auth.getSession();

    if (error || !data?.session?.user) return null;

    const user = data.session.user;

    return await getEmployeeProfileByAuthId(
      user.id,
      user.email || ''
    );
  },

  async getReportsByDepartment(department) {
    const session = await this.getSession();

    const deptId = session?.department_id;

    const deptName =
      typeof department === 'string'
        ? department
        : session?.department;

    let query = sb.from('reports').select('*');

    if (deptId !== null && deptId !== undefined) {
      query = query.eq('department_id', deptId);
    } else if (deptName) {
      query = query.eq('department', deptName);
    }

    const { data, error } = await query;

    if (error || !Array.isArray(data)) return [];

    return data
      .map(row => normalizeReport(row, deptName || ''))
      .sort(
        (a, b) =>
          new Date(b.submitted_at) - new Date(a.submitted_at)
      );
  },

  async getReportById(id, department) {
    const session = await this.getSession();

    const deptId = session?.department_id;

    const deptName =
      typeof department === 'string'
        ? department
        : session?.department;

    let query = sb
      .from('reports')
      .select('*')
      .eq('id', id);

    if (deptId !== null && deptId !== undefined) {
      query = query.eq('department_id', deptId);
    } else if (deptName) {
      query = query.eq('department', deptName);
    }

    const { data, error } = await query.maybeSingle();

    if (error || !data) return null;

    return normalizeReport(data, deptName || '');
  },

  /* ---------------- Update Report + Notification ---------------- */

  async updateReport(id, department, { status, employee_reply }) {
    const session = await this.getSession();

    if (!session) return null;

    const deptId = session.department_id;

    const deptName =
      typeof department === 'string'
        ? department
        : session.department;

    const payload = {
      status,
      employee_reply,
      updated_at: new Date().toISOString()
    };

    // أولاً: تحديث البلاغ في Supabase
    let query = sb
      .from('reports')
      .update(payload)
      .eq('id', id);

    if (deptId !== null && deptId !== undefined) {
      query = query.eq('department_id', deptId);
    } else if (deptName) {
      query = query.eq('department', deptName);
    }

    const { data, error } = await query
      .select('*')
      .maybeSingle();

    if (error || !data) {
      console.error('Report update failed:', error);
      return null;
    }

    const updated = normalizeReport(data, deptName || '');

    // ثانياً: إرسال إشعار إلى Supabase Edge Function
    try {
      const { data: authData, error: authError } =
        await sb.auth.getSession();

      if (authError) {
        throw authError;
      }

      const accessToken = authData?.session?.access_token;

      if (!accessToken) {
        throw new Error('Employee session token not found');
      }

     const response = await fetch(SUPABASE_FUNCTION_URL, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${accessToken}`
  },
  body: JSON.stringify({
    tracking_id: updated.tracking_id
  })
});

      if (!response.ok) {
        const errorText = await response.text();

        console.error(
          'Notification failed:',
          response.status,
          errorText
        );
      } else {
        console.log('Notification request sent successfully');
      }

    } catch (err) {
      console.error('Notification error:', err);
    }

    return updated;
  }

};

/* ---------------- UI utilities ---------------- */

const UI = {

  esc: s =>
    String(s ?? '').replace(
      /[&<>"']/g,
      c => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      }[c])
    ),

  statusBadge: s =>
    `<span class="badge ${STATUS_CLASS[s]}">${STATUS_LABELS[s] || s}</span>`,

  priorityBadge: p =>
    `<span class="badge ${PRIORITY_CLASS[p]}">${PRIORITY_LABELS[p] || p}</span>`,

  formatDate: iso =>
    new Date(iso).toLocaleString('ar-JO-u-nu-latn', {
      dateStyle: 'medium',
      timeStyle: 'short'
    }),

  async requireSession() {
    const s = await DataService.getSession();

    if (!s) {
      location.replace('login.html');
      return null;
    }

    return s;
  },

  emblem:
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12h4l3-7 4 14 3-7h4"/></svg>',

  renderNavbar(user) {
    document.getElementById('navbar').innerHTML = `
      <div class="container nav-inner">
        <a class="brand" href="dashboard.html">
          <span class="emblem">${UI.emblem}</span>
          <span>N-Pulse-AI</span>
        </a>

        <div class="nav-user">
          <span class="avatar" aria-hidden="true">
            ${UI.esc((user.name || 'م').trim()[0])}
          </span>

          <strong class="nav-name">
            ${UI.esc(user.name)}
          </strong>

          <span class="pill">
            ${UI.esc(user.department)}
          </span>

          <button
            class="btn btn-ghost btn-sm"
            id="logout-btn"
            type="button"
          >
            تسجيل الخروج
          </button>
        </div>
      </div>`;

    document
      .getElementById('logout-btn')
      .addEventListener('click', async () => {
        await DataService.logout();
        location.href = 'login.html';
      });
  },

  setLoading(btn, on) {
    btn.classList.toggle('loading', on);
    btn.disabled = on;
    btn.setAttribute('aria-busy', on);
  },

  toast(msg, type = 'success') {
    let t = document.getElementById('toast');

    if (!t) {
      t = document.createElement('div');
      t.id = 'toast';
      t.setAttribute('role', 'status');
      document.body.appendChild(t);
    }

    t.className =
      'toast ' +
      (type === 'error' ? 'error ' : '') +
      'show';

    t.textContent = msg;

    clearTimeout(UI._t);

    UI._t = setTimeout(
      () => t.classList.remove('show'),
      3200
    );
  }

};

