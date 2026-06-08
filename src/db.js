import pg from 'pg'
import { createHash, randomBytes } from 'crypto'
import dotenv from 'dotenv'
dotenv.config()

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })

// ── Startup migrations — idempotent ──────────────────────────────
async function runMigrations() {
  try {
    await pool.query(`
      ALTER TABLE ai_settings
        ADD COLUMN IF NOT EXISTS blacklist_phones TEXT[]        DEFAULT '{}',
        ADD COLUMN IF NOT EXISTS blacklist_all    BOOLEAN       DEFAULT false,
        ADD COLUMN IF NOT EXISTS agent_prompts    JSONB         DEFAULT '{}',
        ADD COLUMN IF NOT EXISTS faqs             JSONB         DEFAULT '[]',
        ADD COLUMN IF NOT EXISTS agent_active     JSONB         DEFAULT '{}',
        ADD COLUMN IF NOT EXISTS custom_agents    JSONB         DEFAULT '[]',
        ADD COLUMN IF NOT EXISTS business_name    VARCHAR(100),
        ADD COLUMN IF NOT EXISTS business_logo    TEXT
    `)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id              SERIAL PRIMARY KEY,
        username        VARCHAR(100) UNIQUE NOT NULL,
        password_hash   VARCHAR(255) NOT NULL,
        name            VARCHAR(100),
        role            VARCHAR(30)  NOT NULL DEFAULT 'usuario',
        active          BOOLEAN      DEFAULT true,
        session_token   VARCHAR(255),
        session_expires TIMESTAMPTZ,
        created_at      TIMESTAMPTZ  DEFAULT NOW(),
        updated_at      TIMESTAMPTZ  DEFAULT NOW()
      )
    `)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS activity_log (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER,
        username   VARCHAR(100),
        action     VARCHAR(200) NOT NULL,
        details    JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id         SERIAL PRIMARY KEY,
        type       VARCHAR(50) NOT NULL,
        title      VARCHAR(200) NOT NULL,
        body       TEXT,
        data       JSONB DEFAULT '{}',
        read       BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `)
    await pool.query(`
      ALTER TABLE conversations
        ADD COLUMN IF NOT EXISTS recontact_at   TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS recontact_sent BOOLEAN DEFAULT false,
        ADD COLUMN IF NOT EXISTS recontact_min  INTEGER DEFAULT 60,
        ADD COLUMN IF NOT EXISTS images_sent    JSONB   DEFAULT '{}'
    `)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS appointments (
        id          SERIAL PRIMARY KEY,
        contact_id  INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
        conv_id     INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
        service     VARCHAR(200) NOT NULL,
        appt_date   DATE NOT NULL,
        time_start  TIME NOT NULL,
        duration    INTEGER DEFAULT 60,
        capacity    INTEGER DEFAULT 1,
        notes       TEXT,
        agent_name  VARCHAR(100),
        status      VARCHAR(30) DEFAULT 'pendiente',
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `)
    // Default superadmin if no users exist
    const existing = await pool.query('SELECT COUNT(*) FROM users')
    if (parseInt(existing.rows[0].count) === 0) {
      const salt = randomBytes(16).toString('hex')
      const hash = createHash('sha256').update(salt + 'admin123').digest('hex')
      await pool.query(
        `INSERT INTO users (username, password_hash, name, role) VALUES ('admin','${salt}:${hash}','Administrador','superadmin')`
      )
      console.log('[DB] Usuario admin creado — cambiá la contraseña desde Usuarios')
    }
    console.log('[DB] Migraciones completadas')
  } catch (e) {
    console.error('[DB migration]', e.message)
  }
}
runMigrations()

// ── Auth helpers ─────────────────────────────────────────────────
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex')
  const hash = createHash('sha256').update(salt + password).digest('hex')
  return `${salt}:${hash}`
}
export function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':')
  return createHash('sha256').update(salt + password).digest('hex') === hash
}

export const db = {
  // ── WhatsApp ──────────────────────────────────────────────────────
  async upsertContact(phone, name) {
    const { rows } = await pool.query(`
      INSERT INTO contacts (phone, name, last_contact_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (phone) DO UPDATE
        SET last_contact_at = NOW(),
            name = COALESCE($2, contacts.name)
      RETURNING *
    `, [phone, name])

    const contact = rows[0]

    let conv = await pool.query(
      'SELECT id FROM conversations WHERE contact_id = $1 ORDER BY last_message_at DESC LIMIT 1',
      [contact.id]
    )

    if (conv.rows.length === 0) {
      conv = await pool.query(
        'INSERT INTO conversations (contact_id) VALUES ($1) RETURNING *',
        [contact.id]
      )
    }

    contact.conversation_id = conv.rows[0].id
    return contact
  },

  async saveMessage(conversationId, sender, content, agentType = 'generalista') {
    await pool.query(`
      INSERT INTO messages (conversation_id, sender, type, content, agent_type)
      VALUES ($1, $2, 'text', $3, $4)
    `, [conversationId, sender, content, agentType])

    await pool.query(
      'UPDATE conversations SET last_message_at = NOW() WHERE id = $1',
      [conversationId]
    )
  },

  async getRecentMessages(conversationId, limit = 10) {
    const { rows } = await pool.query(`
      SELECT sender, content FROM messages
      WHERE conversation_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `, [conversationId, limit])
    return rows.reverse()
  },

  async getAISettings() {
    const { rows } = await pool.query('SELECT * FROM ai_settings LIMIT 1')
    return rows[0]
  },

  async updateAISettings(data) {
    const {
      personality_prompt, business_description, welcome_message, goals, restrictions,
      admin_phone, redirect_phone,
      allowed_phones, blacklist_phones, blacklist_all,
      agent_prompts, faqs, agent_active,
      business_name, business_logo, advisors, business_hours, custom_agents
    } = data
    await pool.query(`
      UPDATE ai_settings SET
        personality_prompt   = COALESCE($1,  personality_prompt),
        business_description = COALESCE($2,  business_description),
        welcome_message      = COALESCE($3,  welcome_message),
        goals                = COALESCE($4,  goals),
        restrictions         = COALESCE($5,  restrictions),
        admin_phone          = COALESCE($6,  admin_phone),
        redirect_phone       = COALESCE($7,  redirect_phone),
        allowed_phones       = COALESCE($8,  allowed_phones),
        blacklist_phones     = COALESCE($9,  blacklist_phones),
        blacklist_all        = COALESCE($10, blacklist_all),
        agent_prompts        = COALESCE($11, agent_prompts),
        faqs                 = COALESCE($12, faqs),
        agent_active         = COALESCE($13, agent_active),
        business_name        = COALESCE($14, business_name),
        business_logo        = COALESCE($15, business_logo),
        advisors             = COALESCE($16, advisors),
        business_hours       = COALESCE($17, business_hours),
        custom_agents        = COALESCE($18, custom_agents),
        updated_at           = NOW()
      WHERE id = (SELECT id FROM ai_settings LIMIT 1)
    `, [
      personality_prompt, business_description, welcome_message, goals, restrictions,
      admin_phone || null, redirect_phone || null,
      Array.isArray(allowed_phones)   ? allowed_phones   : null,
      Array.isArray(blacklist_phones) ? blacklist_phones : null,
      typeof blacklist_all === 'boolean' ? blacklist_all : null,
      agent_prompts && typeof agent_prompts === 'object' ? JSON.stringify(agent_prompts) : null,
      Array.isArray(faqs)            ? JSON.stringify(faqs)          : null,
      agent_active && typeof agent_active === 'object' ? JSON.stringify(agent_active) : null,
      business_name || null,
      business_logo !== undefined ? (business_logo || null) : undefined,
      Array.isArray(advisors) ? JSON.stringify(advisors) : null,
      business_hours && typeof business_hours === 'object' ? JSON.stringify(business_hours) : null,
      Array.isArray(custom_agents) ? JSON.stringify(custom_agents) : null,
    ])
    return this.getAISettings()
  },

  // ── Users ─────────────────────────────────────────────────────────
  async getUsers() {
    const { rows } = await pool.query(
      `SELECT id, username, name, role, active, created_at, updated_at FROM users ORDER BY created_at ASC`
    )
    return rows
  },

  async getUserByToken(token) {
    const { rows } = await pool.query(
      `SELECT id, username, name, role, active FROM users WHERE session_token = $1 AND session_expires > NOW() AND active = true LIMIT 1`,
      [token]
    )
    return rows[0] || null
  },

  async loginUser(username, password) {
    const { rows } = await pool.query(`SELECT * FROM users WHERE username = $1 AND active = true`, [username])
    if (!rows[0]) return null
    if (!verifyPassword(password, rows[0].password_hash)) return null
    const token = randomBytes(32).toString('hex')
    await pool.query(
      `UPDATE users SET session_token = $1, session_expires = NOW() + INTERVAL '7 days', updated_at = NOW() WHERE id = $2`,
      [token, rows[0].id]
    )
    return { id: rows[0].id, username: rows[0].username, name: rows[0].name, role: rows[0].role, token }
  },

  async createUser(data) {
    const { username, password, name, role } = data
    const password_hash = hashPassword(password)
    const { rows } = await pool.query(
      `INSERT INTO users (username, password_hash, name, role) VALUES ($1,$2,$3,$4) RETURNING id, username, name, role, active, created_at`,
      [username, password_hash, name || username, role || 'usuario']
    )
    return rows[0]
  },

  async updateUser(id, data) {
    const { name, role, active, password } = data
    if (password) {
      const password_hash = hashPassword(password)
      await pool.query(
        `UPDATE users SET name=COALESCE($2,name), role=COALESCE($3,role), active=COALESCE($4,active), password_hash=$5, updated_at=NOW() WHERE id=$1`,
        [id, name || null, role || null, active ?? null, password_hash]
      )
    } else {
      await pool.query(
        `UPDATE users SET name=COALESCE($2,name), role=COALESCE($3,role), active=COALESCE($4,active), updated_at=NOW() WHERE id=$1`,
        [id, name || null, role || null, active ?? null]
      )
    }
    const { rows } = await pool.query(`SELECT id, username, name, role, active, created_at FROM users WHERE id=$1`, [id])
    return rows[0]
  },

  async deleteUser(id) {
    await pool.query(`DELETE FROM users WHERE id=$1`, [id])
  },

  // ── Activity log ──────────────────────────────────────────────────
  async logActivity(userId, username, action, details = null) {
    await pool.query(
      `INSERT INTO activity_log (user_id, username, action, details) VALUES ($1,$2,$3,$4)`,
      [userId || null, username || 'sistema', action, details ? JSON.stringify(details) : null]
    )
  },

  async getActivityLog(limit = 100) {
    const { rows } = await pool.query(
      `SELECT id, username, action, details, created_at FROM activity_log ORDER BY created_at DESC LIMIT $1`,
      [limit]
    )
    return rows
  },

  async getConversations() {
    const { rows } = await pool.query(`
      SELECT
        conv.id,
        conv.last_message_at,
        c.phone,
        c.name,
        c.first_contact_at,
        (SELECT content FROM messages WHERE conversation_id = conv.id ORDER BY created_at DESC LIMIT 1) AS last_message,
        (SELECT sender  FROM messages WHERE conversation_id = conv.id ORDER BY created_at DESC LIMIT 1) AS last_sender,
        (SELECT COUNT(*) FROM messages WHERE conversation_id = conv.id)::int AS message_count
      FROM conversations conv
      JOIN contacts c ON c.id = conv.contact_id
      ORDER BY conv.last_message_at DESC NULLS LAST
      LIMIT 100
    `)
    return rows
  },

  async getMessages(conversationId) {
    const { rows } = await pool.query(`
      SELECT id, sender, type, content, agent_type, created_at
      FROM messages
      WHERE conversation_id = $1
      ORDER BY created_at ASC
    `, [conversationId])
    return rows
  },

  async getStats() {
    const msgs24h = await pool.query(`SELECT COUNT(*) as total FROM messages WHERE created_at > NOW() - INTERVAL '24 hours'`)
    const contacts = await pool.query(`SELECT COUNT(*) as total FROM contacts`)
    const total    = await pool.query(`SELECT COUNT(*) as total FROM messages`)
    const convs    = await pool.query(`SELECT COUNT(*) as total FROM conversations`)
    const aiMsgs   = await pool.query(`SELECT COUNT(*) as total FROM messages WHERE sender = 'ai'`)
    return {
      messages_24h:        parseInt(msgs24h.rows[0].total),
      total_contacts:      parseInt(contacts.rows[0].total),
      total_messages:      parseInt(total.rows[0].total),
      total_conversations: parseInt(convs.rows[0].total),
      ai_messages:         parseInt(aiMsgs.rows[0].total),
    }
  },

  async getWeeklyActivity() {
    const { rows } = await pool.query(`
      SELECT
        DATE_TRUNC('day', created_at AT TIME ZONE 'America/Argentina/Buenos_Aires') AS day,
        COUNT(*) FILTER (WHERE sender = 'client') AS client_msgs,
        COUNT(*) FILTER (WHERE sender = 'ai')     AS ai_msgs
      FROM messages
      WHERE created_at > NOW() - INTERVAL '7 days'
      GROUP BY 1 ORDER BY 1
    `)
    return rows.map(r => ({ day: r.day, client: parseInt(r.client_msgs), ai: parseInt(r.ai_msgs) }))
  },

  async getHourlyActivity() {
    const { rows } = await pool.query(`
      SELECT
        EXTRACT(HOUR FROM created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::int AS hour,
        COUNT(*) AS total
      FROM messages
      WHERE created_at > NOW() - INTERVAL '24 hours'
      GROUP BY 1 ORDER BY 1
    `)
    const result = Array.from({ length: 24 }, (_, h) => ({ hour: h, total: 0 }))
    for (const r of rows) result[r.hour].total = parseInt(r.total)
    return result
  },

  // ── Products ──────────────────────────────────────────────────────
  async getProducts() {
    const { rows } = await pool.query(`
      SELECT p.*,
        COALESCE(
          json_agg(json_build_object('id', pi.id, 'name', pi.image_name, 'data', pi.image_data))
          FILTER (WHERE pi.id IS NOT NULL), '[]'
        ) AS images
      FROM products p
      LEFT JOIN product_images pi ON pi.product_id = p.id
      WHERE p.active = true
      GROUP BY p.id
      ORDER BY p.created_at DESC
    `)
    return rows
  },

  async getActiveProducts() {
    const { rows } = await pool.query(`
      SELECT id, name, category, price, description, availability, ai_when, ai_how, keywords, can_send_image
      FROM products
      WHERE active = true
      ORDER BY category, name
    `)
    return rows
  },

  async createProduct(data) {
    const { name, category, price, description, availability, ai_when, ai_how, keywords, can_send_image } = data
    const { rows } = await pool.query(`
      INSERT INTO products (name, category, price, description, availability, ai_when, ai_how, keywords, can_send_image)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `, [name, category || 'servicio', price || null, description || null, availability || null,
        ai_when || null, ai_how || null, keywords || [], can_send_image || false])
    return rows[0]
  },

  async updateProduct(id, data) {
    const { name, category, price, description, availability, ai_when, ai_how, keywords, can_send_image } = data
    const { rows } = await pool.query(`
      UPDATE products SET
        name          = COALESCE($2, name),
        category      = COALESCE($3, category),
        price         = $4,
        description   = $5,
        availability  = $6,
        ai_when       = $7,
        ai_how        = $8,
        keywords      = COALESCE($9, keywords),
        can_send_image = COALESCE($10, can_send_image),
        updated_at    = NOW()
      WHERE id = $1
      RETURNING *
    `, [id, name, category, price || null, description || null, availability || null,
        ai_when || null, ai_how || null, keywords, can_send_image])
    return rows[0]
  },

  async deleteProduct(id) {
    await pool.query('UPDATE products SET active = false WHERE id = $1', [id])
  },

  async addProductImage(productId, imageData, imageName) {
    const { rows } = await pool.query(`
      INSERT INTO product_images (product_id, image_data, image_name)
      VALUES ($1, $2, $3) RETURNING id, image_name
    `, [productId, imageData, imageName || null])
    return rows[0]
  },

  async deleteProductImage(imageId) {
    await pool.query('DELETE FROM product_images WHERE id = $1', [imageId])
  },

  // ── Catalog images ────────────────────────────────────────────────
  async getCatalogImages() {
    const { rows } = await pool.query(`
      SELECT id, name, description, context_when, image_data, created_at
      FROM catalog_images
      WHERE active = true
      ORDER BY created_at DESC
    `)
    return rows
  },

  async addCatalogImage(data) {
    const { name, description, context_when, image_data } = data
    const { rows } = await pool.query(`
      INSERT INTO catalog_images (name, description, context_when, image_data)
      VALUES ($1, $2, $3, $4)
      RETURNING id, name, description, context_when, created_at
    `, [name, description || null, context_when || null, image_data])
    return rows[0]
  },

  async deleteCatalogImage(id) {
    await pool.query('DELETE FROM catalog_images WHERE id = $1', [id])
  },

  async updateCatalogImage(id, data) {
    const { name, description, context_when, image_data } = data
    const { rows } = await pool.query(`
      UPDATE catalog_images SET
        name         = COALESCE($2, name),
        description  = COALESCE($3, description),
        context_when = COALESCE($4, context_when),
        image_data   = COALESCE($5, image_data)
      WHERE id = $1
      RETURNING id, name, description, context_when, created_at
    `, [id, name || null, description || null, context_when || null, image_data || null])
    return rows[0]
  },

  // ── Notifications ─────────────────────────────────────────────────
  async createNotification(type, title, body, data = {}) {
    const { rows } = await pool.query(
      `INSERT INTO notifications (type, title, body, data) VALUES ($1,$2,$3,$4) RETURNING *`,
      [type, title, body || null, JSON.stringify(data)]
    )
    return rows[0]
  },

  async getNotifications(limit = 100) {
    const { rows } = await pool.query(
      `SELECT * FROM notifications ORDER BY created_at DESC LIMIT $1`, [limit]
    )
    return rows
  },

  async getUnreadCount() {
    const { rows } = await pool.query(`SELECT COUNT(*) FROM notifications WHERE read = false`)
    return parseInt(rows[0].count)
  },

  async markNotificationRead(id) {
    await pool.query(`UPDATE notifications SET read = true WHERE id = $1`, [id])
  },

  async markAllNotificationsRead() {
    await pool.query(`UPDATE notifications SET read = true WHERE read = false`)
  },

  // ── Conversation helpers ──────────────────────────────────────────
  async getConversationWithContact(convId) {
    const { rows } = await pool.query(`
      SELECT conv.id, conv.last_message_at, conv.recontact_min,
             c.phone, c.name
      FROM conversations conv
      JOIN contacts c ON c.id = conv.contact_id
      WHERE conv.id = $1
    `, [convId])
    return rows[0] || null
  },

  async getConversationsForRecontact() {
    const { rows } = await pool.query(`
      SELECT conv.id AS conversation_id, COALESCE(conv.recontact_min, 60) AS recontact_min,
             c.phone, c.name,
             conv.last_message_at
      FROM conversations conv
      JOIN contacts c ON c.id = conv.contact_id
      WHERE COALESCE(conv.recontact_sent, false) = false
        AND conv.last_message_at IS NOT NULL
        AND (SELECT sender FROM messages WHERE conversation_id = conv.id ORDER BY created_at DESC LIMIT 1) = 'ai'
        AND conv.last_message_at < NOW() - (COALESCE(conv.recontact_min, 60)::text || ' minutes')::INTERVAL
    `)
    return rows
  },

  async setRecontactSent(convId) {
    await pool.query(`UPDATE conversations SET recontact_sent = true WHERE id = $1`, [convId])
  },

  async resetRecontact(convId) {
    await pool.query(`UPDATE conversations SET recontact_sent = false WHERE id = $1`, [convId])
  },

  // ── Images sent tracking ──────────────────────────────────────────
  async getImagesSent(convId) {
    const { rows } = await pool.query(
      `SELECT images_sent FROM conversations WHERE id = $1`, [convId]
    )
    return rows[0]?.images_sent || {}
  },

  async markImageSent(convId, productId, productName) {
    const key = String(productId || productName || 'unknown')
    await pool.query(
      `UPDATE conversations SET images_sent = images_sent || $2::jsonb WHERE id = $1`,
      [convId, JSON.stringify({ [key]: { name: productName, sent_at: new Date().toISOString() } })]
    )
  },

  // ── Appointments ──────────────────────────────────────────────────
  async createAppointment(data) {
    const { contact_id, conv_id, service, appt_date, time_start, duration, capacity, notes, agent_name } = data
    const { rows } = await pool.query(`
      INSERT INTO appointments (contact_id, conv_id, service, appt_date, time_start, duration, capacity, notes, agent_name)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *
    `, [contact_id || null, conv_id || null, service, appt_date, time_start, duration || 60, capacity || 1, notes || null, agent_name || null])
    return rows[0]
  },

  async getAppointments({ from, to } = {}) {
    let q = `
      SELECT a.*, c.name AS contact_name, c.phone AS contact_phone
      FROM appointments a
      LEFT JOIN contacts c ON c.id = a.contact_id
      WHERE a.status != 'cancelado'
    `
    const params = []
    if (from) { params.push(from); q += ` AND a.appt_date >= $${params.length}` }
    if (to)   { params.push(to);   q += ` AND a.appt_date <= $${params.length}` }
    q += ` ORDER BY a.appt_date ASC, a.time_start ASC`
    const { rows } = await pool.query(q, params)
    return rows
  },

  async getAppointment(id) {
    const { rows } = await pool.query(`
      SELECT a.*, c.name AS contact_name, c.phone AS contact_phone
      FROM appointments a
      LEFT JOIN contacts c ON c.id = a.contact_id
      WHERE a.id = $1
    `, [id])
    return rows[0] || null
  },

  async updateAppointment(id, data) {
    const { service, appt_date, time_start, duration, capacity, notes, agent_name, status } = data
    const { rows } = await pool.query(`
      UPDATE appointments SET
        service    = COALESCE($2, service),
        appt_date  = COALESCE($3, appt_date),
        time_start = COALESCE($4, time_start),
        duration   = COALESCE($5, duration),
        capacity   = COALESCE($6, capacity),
        notes      = $7,
        agent_name = COALESCE($8, agent_name),
        status     = COALESCE($9, status),
        updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [id, service || null, appt_date || null, time_start || null, duration || null, capacity || null, notes ?? null, agent_name || null, status || null])
    return rows[0]
  },

  async deleteAppointment(id) {
    await pool.query(`UPDATE appointments SET status = 'cancelado', updated_at = NOW() WHERE id = $1`, [id])
  },
}
