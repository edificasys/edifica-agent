import pkg from '@whiskeysockets/baileys'
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } = pkg
import { Boom } from '@hapi/boom'
import QRCode from 'qrcode'
import cron from 'node-cron'
import http from 'http'
import dotenv from 'dotenv'
import fs from 'fs'
import Groq from 'groq-sdk'
import { put } from '@vercel/blob'
import { db } from './db.js'
import { getAIReply, getAdvisorInfo, createGroqChat } from './ai.js'
import { parsePlanillaText, generatePlanillaPDF } from './pdfPlanilla.js'
import { sendAdminAlert, setAdminSocket } from './alerts.js'

dotenv.config()

let messageCount = 0
let restartCount = 0
const startTime = Date.now()
let latestQR = null
let connectionStatus = 'disconnected'  // 'disconnected' | 'qr' | 'connected' | 'logged_out'
let activeSock = null  // exposed for manual send + recontacto
const notifClients = new Set()  // SSE clients for live notifications

// ── Log capture para SSE ──────────────────────────────────────────────
const LOG_BUFFER_SIZE = 300
const logBuffer = []
const logClients = new Set()

function pushLog(level, ...args) {
  const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')
  const entry = { t: Date.now(), level, msg }
  logBuffer.push(entry)
  if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift()
  const data = `data: ${JSON.stringify(entry)}\n\n`
  for (const client of logClients) {
    try { client.write(data) } catch { logClients.delete(client) }
  }
}

const _origLog   = console.log
const _origError = console.error
console.log   = (...a) => { _origLog(...a);   pushLog('info',  ...a) }
console.error = (...a) => { _origError(...a); pushLog('error', ...a) }

// ── WhatsApp ──────────────────────────────────────────────────────────
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info')
  const { version } = await fetchLatestBaileysVersion()

  const sock = activeSock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: true,
    getMessage: async (key) => {
      return { conversation: 'Mensaje desencriptado' }
    },
    logger: {
      level: 'silent', log: () => {}, info: () => {}, warn: () => {},
      error: console.error, trace: () => {}, debug: () => {},
      child: () => ({ level: 'silent', log: () => {}, info: () => {}, warn: () => {}, error: console.error, trace: () => {}, debug: () => {} })
    }
  })

  setAdminSocket(sock)
  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      latestQR = qr
      connectionStatus = 'qr'
      console.log('Nuevo QR generado. Escanealo en el dashboard.')
    }

    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode
      const shouldReconnect = code !== DisconnectReason.loggedOut
      connectionStatus = shouldReconnect ? 'disconnected' : 'logged_out'
      restartCount++
      console.log(`Conexión cerrada. Código: ${code}. Reconectando: ${shouldReconnect}`)

      if (shouldReconnect) {
        console.log('Reconectando en 5 segundos...')
        setTimeout(connectToWhatsApp, 5000)
      } else {
        await sendAdminAlert('Sesión cerrada de WhatsApp.\nEscaneá el QR de nuevo desde el dashboard.')
        console.log('Sesión cerrada. Necesita nuevo QR. Limpiando sesión y generando nuevo QR...')
        if (fs.existsSync('./auth_info')) {
          fs.rmSync('./auth_info', { recursive: true, force: true })
        }
        setTimeout(connectToWhatsApp, 5000)
      }
    }

    if (connection === 'open') {
      connectionStatus = 'connected'
      latestQR = null
      console.log('Conectado a WhatsApp correctamente')
      await sendAdminAlert(
        'Worker conectado y funcionando.\n' +
        `Hora: ${new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}`
      )
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return

    for (const msg of messages) {
      if (msg.key.fromMe) continue          // saltar propios
      if (!msg.message) continue            // saltar vacíos

      const jid = msg.key.remoteJid || ''
      if (!jid) continue
      if (jid.endsWith('@g.us')) continue                   // ignorar grupos
      if (jid === 'status@broadcast') continue              // ignorar estados/stories
      // WhatsApp usa @lid (ID interno) en cuentas nuevas en vez del número real
      const isLid = jid.endsWith('@lid')
      const isPhone = jid.endsWith('@s.whatsapp.net')
      if (!isPhone && !isLid) {
        console.log(`[SKIP] JID desconocido: ${jid}`)
        continue
      }

      // Obtener el número real si viene en alt o participant
      const realPhoneJid = msg.key?.remoteJidAlt || (isPhone ? jid : null)
      const realPhone = realPhoneJid ? realPhoneJid.replace('@s.whatsapp.net', '') : null
      const identifier = realPhone || (isPhone ? jid.replace('@s.whatsapp.net', '') : jid.replace('@lid', ''))

      console.log(`[MSG] jid=${jid} id=${identifier} lid=${isLid} name=${msg.pushName}`)

      // Leer config de BD (teléfonos se gestionan desde el dashboard en Mi Negocio -> Asesores)
      const settings = await db.getAISettings().catch(() => null)
      const advisorInfo = getAdvisorInfo(settings)
      const ADMIN    = settings?.admin_phone    || process.env.ADMIN_PHONE    || advisorInfo.phone || ''
      const REDIRECT = settings?.redirect_phone || process.env.REDIRECT_PHONE || advisorInfo.phone || ''

      if (ADMIN && identifier === ADMIN) continue

      // Blacklist global (nadie puede chatear)
      if (settings?.blacklist_all) {
        console.log(`[BLOQUEADO] Blacklist global activa — ignorando ${identifier}`)
        continue
      }

      // Whitelist (solo ciertos números permitidos)
      const ALLOWED = (settings?.allowed_phones?.length)
        ? settings.allowed_phones
        : (process.env.ALLOWED_PHONES || '').split(',').map(p => p.trim()).filter(Boolean)
      if (ALLOWED.length > 0 && !ALLOWED.includes(identifier)) {
        console.log(`[BLOQUEADO] "${identifier}" no está en whitelist [${ALLOWED.join(', ')}]`)
        continue
      }

      // Blacklist específica (números bloqueados individualmente)
      const BLACKLIST = settings?.blacklist_phones || []
      if (BLACKLIST.includes(identifier)) {
        console.log(`[BLOQUEADO] "${identifier}" está en blacklist`)
        continue
      }
      console.log(`[PERMITIDO] ${identifier} (${msg.pushName})`)

      const text     = msg.message.conversation || msg.message.extendedTextMessage?.text || ''
      const hasImage = !!msg.message.imageMessage
      const hasAudio = !!msg.message.audioMessage || !!msg.message.pttMessage
      const audioMime = msg.message.audioMessage?.mimetype || msg.message.pttMessage?.mimetype || 'audio/ogg'
      let imageBuffer = null
      let audioBuffer = null

      try {
        if (hasImage) {
          try { imageBuffer = await downloadMediaMessage(msg, 'buffer', {}) } catch (e) { console.error('[IMG] Error descarga:', e.message) }
        }
        if (hasAudio) {
          try { audioBuffer = await downloadMediaMessage(msg, 'buffer', {}) } catch (e) { console.error('[AUDIO] Error descarga:', e.message) }
        }

        const contact = await db.upsertContact(identifier, msg.pushName || '', jid)

        // Detectar si es primer mensaje de este contacto (history vacío antes de guardar)
        const prevHistory = await db.getRecentMessages(contact.conversation_id, 1)
        const isFirstMessage = prevHistory.length === 0

        const history = await db.getRecentMessages(contact.conversation_id, 10)

        // Reset recontacto porque el cliente volvió a escribir
        await db.resetRecontact(contact.conversation_id).catch(() => {})

        // Imágenes ya enviadas en esta conversación
        const imagesSent = await db.getImagesSent(contact.conversation_id).catch(() => ({}))

        const convInfo = await db.getConversationWithContact(contact.conversation_id)
        if (convInfo?.bot_paused) {
          const saved = text || (hasImage ? '[imagen]' : hasAudio ? '[audio]' : '[mensaje]')
          await db.saveMessage(contact.conversation_id, 'client', saved, 'cliente', null, hasAudio ? 'audio' : hasImage ? 'image' : 'text')
          await createAndPushNotif('conv_active', 'Mensaje (bot en pausa)', `${msg.pushName || identifier}: "${saved.substring(0, 60)}"`, { convId: contact.conversation_id, phone: identifier, name: msg.pushName || '' })
          continue
        }

        const result = await getAIReply({ text, hasImage, imageBuffer, hasAudio, audioBuffer, audioMime, history, clientName: msg.pushName || identifier, imagesSent, isFirstMessage })

        const { reply, agentType, isHandoff, isPlanillaHandoff, summary, imageInfo, imageDescription, transcribedText } = result

        let uploadedMediaUrl = null
        const msgType = hasAudio ? 'audio' : hasImage ? 'image' : 'text'

        if (hasImage && imageBuffer) {
          if (process.env.BLOB_READ_WRITE_TOKEN) {
            try {
              const blob = await put(`whatsapp/${Date.now()}.jpg`, imageBuffer, {
                access: 'public',
                token: process.env.BLOB_READ_WRITE_TOKEN
              })
              uploadedMediaUrl = blob.url
              console.log('[Blob] Imagen subida a Vercel:', uploadedMediaUrl)
            } catch (err) {
              console.error('[Blob] Error subiendo imagen:', err.message)
            }
          }
          // Fallback a Base64 data URL para asegurar visualización en el dashboard
          if (!uploadedMediaUrl) {
            uploadedMediaUrl = `data:image/jpeg;base64,${imageBuffer.toString('base64')}`
          }
        }

        if (hasAudio && audioBuffer) {
          if (process.env.BLOB_READ_WRITE_TOKEN) {
            try {
              const ext = audioMime.includes('mp4') ? 'm4a' : audioMime.includes('mpeg') ? 'mp3' : 'ogg'
              const blob = await put(`whatsapp/${Date.now()}.${ext}`, audioBuffer, {
                access: 'public',
                token: process.env.BLOB_READ_WRITE_TOKEN
              })
              uploadedMediaUrl = blob.url
              console.log('[Blob] Audio subido a Vercel:', uploadedMediaUrl)
            } catch (err) {
              console.error('[Blob] Error subiendo audio:', err.message)
            }
          }
          // Fallback a Base64 data URL para reproducción de audio en el dashboard
          if (!uploadedMediaUrl) {
            const cleanMime = audioMime.split(';')[0] || 'audio/ogg'
            uploadedMediaUrl = `data:${cleanMime};base64,${audioBuffer.toString('base64')}`
          }
        }

        // Formatear mensaje para el historial y chat
        let saved = text || ''
        if (hasAudio) {
          saved = transcribedText ? `🎤 [Audio transcripto]: "${transcribedText}"` : '🎤 [Audio recibido]'
        } else if (hasImage) {
          saved = imageDescription ? (text ? `${text} 🖼️ [Imagen: ${imageDescription.substring(0, 100)}]` : `🖼️ [Imagen: ${imageDescription.substring(0, 120)}]`) : (text ? `${text} 🖼️ [Imagen]` : '🖼️ [Imagen]')
        } else if (!saved) {
          saved = '[Mensaje]'
        }

        await db.saveMessage(contact.conversation_id, 'client', saved, 'cliente', uploadedMediaUrl, msgType)
        await db.saveMessage(contact.conversation_id, 'ai', reply, agentType, null, 'text')

        // Enviar respuesta al cliente vía WhatsApp
        try {
          await sock.sendMessage(msg.key.remoteJid, { text: reply })
        } catch (sendErr) {
          console.error(`[WA Send Error to ${msg.key.remoteJid}]:`, sendErr.message)
          if (msg.key.remoteJid?.endsWith('@lid') && identifier && !identifier.includes('@') && identifier !== jid.replace('@lid', '')) {
            try {
              await sock.sendMessage(`${identifier}@s.whatsapp.net`, { text: reply })
              console.log(`[WA Send] Reintento exitoso a ${identifier}@s.whatsapp.net`)
            } catch (retryErr) {
              console.error(`[WA Send Retry Error]:`, retryErr.message)
            }
          }
        }

        // Enviar imagen de producto (solo si no fue enviada ya en esta conversación)
        if (imageInfo) {
          const productKey = String(imageInfo.productId || imageInfo.productName || 'unknown')
          const alreadySent = !!imagesSent[productKey]

          if (!alreadySent && imageInfo.imageData) {
            try {
              const base64 = imageInfo.imageData.replace(/^data:image\/\w+;base64,/, '')
              const imgBuffer = Buffer.from(base64, 'base64')
              await sock.sendMessage(msg.key.remoteJid, { image: imgBuffer, caption: imageInfo.productName || '' })
              await db.markImageSent(contact.conversation_id, imageInfo.productId, imageInfo.productName)
              await createAndPushNotif('image_sent', 'Imagen enviada', `Se envió imagen de "${imageInfo.productName}" a ${msg.pushName || identifier}`, { convId: contact.conversation_id, phone: identifier, productName: imageInfo.productName })
            } catch (imgErr) {
              console.error('[IMG] Error enviando imagen:', imgErr.message)
            }
          }
          // Si el producto existe pero no tiene imagen cargada
          if (!imageInfo.imageData) {
            const prodDesc = imageInfo.productDescription ? `\n\n${imageInfo.productDescription}` : ''
            const advisorLinkMsg = advisorInfo.link
              ? `\n\nPronto las podrás ver aquí. Si querés más detalles, podés contactar a nuestro asesor 👇\n${advisorInfo.link}`
              : `\n\nPronto las podrás ver aquí. Dejanos tu consulta y te responderemos a la brevedad.`
            await sock.sendMessage(msg.key.remoteJid, { text: `Por el momento estamos cargando las imágenes de ${imageInfo.productName}.${prodDesc}${advisorLinkMsg}` })
            await createAndPushNotif('missing_image', `Imagen faltante: ${imageInfo.productName}`, `${msg.pushName || identifier} pidió ver "${imageInfo.productName}" pero no tiene imágenes cargadas`, { convId: contact.conversation_id, phone: identifier, productId: imageInfo.productId, productName: imageInfo.productName })
          }
        } else if (agentType === 'productos' && /foto|imagen|ver|mostrá|catálogo/i.test(text || '')) {
          await createAndPushNotif('missing_image', 'Cliente pide imágenes', `${msg.pushName || identifier} pidió ver imágenes/catálogo pero no se encontró producto específico`, { convId: contact.conversation_id, phone: identifier })
        }

        // Notificación: primer contacto o conversación activa
        if (isFirstMessage) {
          await createAndPushNotif('new_contact', 'Nuevo cliente', `${msg.pushName || identifier} se contactó por primera vez`, { convId: contact.conversation_id, phone: identifier, name: msg.pushName || '' })
        } else {
          await createAndPushNotif('conv_active', 'Conversación activa', `${msg.pushName || identifier}: "${(text || saved).substring(0, 60)}"`, { convId: contact.conversation_id, phone: identifier, name: msg.pushName || '' })
        }

        // Derivación especial: Planilla de Medidas confirmada (genera PDF y rota asesor)
        if (isPlanillaHandoff && summary) {
          const clientName = msg.pushName || identifier

          // 1. Asignar asesor rotado (Round-Robin estricto para no mandar a todos ni repetir)
          const chosenAdvisor = await db.getNextRotatedAdvisor(settings, 'medidas')
          const advisorPhone = chosenAdvisor.phone || REDIRECT

          // 2. Generar el PDF oficial con el diseño exacto de EDIFICA EQUIPAMIENTOS
          let pdfBuffer = null
          let parsedData = null
          try {
            parsedData = parsePlanillaText(summary, clientName)
            pdfBuffer = await generatePlanillaPDF(parsedData)
            console.log(`[PLANILLA] PDF generado exitosamente (${pdfBuffer.length} bytes) para ${parsedData.obra || clientName}`)
          } catch (pdfErr) {
            console.error('[PLANILLA] Error generando PDF:', pdfErr.message)
          }

          const planillaAdvisorMsg =
            `📐 *NUEVA PLANILLA DE MEDIDAS DE OBRA*\n\n` +
            `👤 *Cliente:* ${clientName}\n` +
            `📱 *WhatsApp:* wa.me/+${identifier}\n` +
            `📍 *Dirección:* ${parsedData?.direccion || 'A confirmar'}\n` +
            `👷 *Asesor asignado:* ${chosenAdvisor.name}\n\n` +
            `${summary}\n\n` +
            `📎 *Adjunto el documento PDF oficial con el relevamiento técnico.*\n\n` +
            `⏰ ${new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}`

          // 3. Enviar PDF y datos exclusivamente AL ASESOR ASIGNADO (SOLO A UNO)
          try {
            if (advisorPhone) {
              const cleanAdvisorPhone = String(advisorPhone).replace(/[^0-9]/g, '')
              await sock.sendMessage(`${cleanAdvisorPhone}@s.whatsapp.net`, { text: planillaAdvisorMsg })
              if (pdfBuffer) {
                await sock.sendMessage(`${cleanAdvisorPhone}@s.whatsapp.net`, {
                  document: pdfBuffer,
                  mimetype: 'application/pdf',
                  fileName: `Planilla_Medidas_${(parsedData?.obra || clientName).replace(/[^a-zA-Z0-9]/g, '_')}.pdf`,
                  caption: `📄 Planilla oficial de relevamiento - Obra ${parsedData?.obra || clientName}`
                })
              }
              console.log(`[PLANILLA] Planilla y PDF enviados exclusivamente al asesor rotado ${cleanAdvisorPhone} (${chosenAdvisor.name})`)
            }
          } catch (e) {
            console.error('[PLANILLA] Error enviando planilla al asesor:', e.message)
          }

          // 4. Enviar PDF también AL CLIENTE para su constancia
          try {
            if (pdfBuffer) {
              await sock.sendMessage(msg.key.remoteJid, {
                document: pdfBuffer,
                mimetype: 'application/pdf',
                fileName: `Planilla_Medidas_${(parsedData?.obra || clientName).replace(/[^a-zA-Z0-9]/g, '_')}.pdf`,
                caption: `📄 ¡Acá tenés la Planilla de Medidas oficial en PDF de tu obra! Ya se la envié a nuestro asesor técnico para preparar la cotización y coordinar producción. 🙌`
              })
              console.log(`[PLANILLA] PDF enviado al cliente ${identifier}`)
            }
          } catch (e) {
            console.error('[PLANILLA] Error enviando PDF al cliente:', e.message)
          }

          // 5. Guardar en Base de Datos con su PDF en Base64
          await db.savePlanillaMedidas({
            conv_id: contact.conversation_id,
            contact_id: contact.id,
            obra: parsedData?.obra || clientName,
            direccion: parsedData?.direccion || null,
            relevo: parsedData?.relevo || clientName,
            vanos: parsedData?.vanos || [],
            observaciones: parsedData?.observaciones || null,
            formatted_text: summary,
            pdf_base64: pdfBuffer ? pdfBuffer.toString('base64') : null,
            status: 'confirmada'
          }).catch(err => console.error('[DB Planilla Error]:', err.message))

          await createAndPushNotif('planilla_medidas', 'Planilla de Medidas confirmada', `${clientName} completó la planilla de relevamiento (Asesor: ${chosenAdvisor.name})`, {
            convId: contact.conversation_id,
            phone: identifier,
            name: clientName,
            summary,
            advisor: chosenAdvisor.name,
            waLink: `https://wa.me/${identifier}`
          })
        } else if (isHandoff && summary) {
          // Derivación general a asesor (asignación equitativa Round-Robin a un solo asesor)
          const clientName = msg.pushName || identifier
          const chosenAdvisor = await db.getNextRotatedAdvisor(settings)
          const advisorPhone = chosenAdvisor.phone || REDIRECT
          const imgLine = imageDescription ? `\n🖼️ *Imagen enviada por el cliente:* ${imageDescription}\n` : ''
          const adminMsg =
            `🔔 *Cliente derivado a asesor*\n\n` +
            `👤 *Cliente:* ${clientName}\n` +
            `📱 *Número:* wa.me/+${identifier}\n` +
            `👷 *Asesor asignado:* ${chosenAdvisor.name}\n\n` +
            `📋 *Resumen de la consulta:*\n${summary}${imgLine}\n` +
            `⏰ ${new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}`
          try {
            if (advisorPhone) {
              const validPhone = String(advisorPhone).replace(/[^0-9]/g, '')
              await sock.sendMessage(`${validPhone}@s.whatsapp.net`, { text: adminMsg })
              if (imageBuffer && imageDescription) {
                await sock.sendMessage(`${validPhone}@s.whatsapp.net`, { image: imageBuffer, caption: `📎 Imagen enviada por ${clientName}` })
              }
              console.log(`[REDIR] Resumen enviado exclusivamente al asesor rotado ${validPhone} (${chosenAdvisor.name})`)
            }
          } catch (e) {
            console.error('[REDIR] Error enviando resumen al asesor:', e.message)
          }
          await createAndPushNotif('handoff', 'Derivación a asesor', `${clientName} fue derivado al asesor ${chosenAdvisor.name}`, { convId: contact.conversation_id, phone: identifier, name: clientName, summary, advisor: chosenAdvisor.name, waLink: `https://wa.me/${identifier}` })
        }

        messageCount++
        const preview = text || (hasImage ? '[imagen]' : '[audio]')
        console.log(`[${identifier}][${agentType}] → "${preview.substring(0, 40)}" → "${reply.substring(0, 40)}"`)
      } catch (err) {
        console.error(`Error procesando mensaje de ${identifier}:`, err.message)
      }
    }
  })

  return sock
}

// ── Push notification to SSE clients ─────────────────────────────────
function pushNotification(notif) {
  const data = `data: ${JSON.stringify(notif)}\n\n`
  for (const client of notifClients) {
    try { client.write(data) } catch { notifClients.delete(client) }
  }
}

async function createAndPushNotif(type, title, body, data = {}) {
  try {
    const n = await db.createNotification(type, title, body, data)
    pushNotification(n)
  } catch (e) {
    console.error('[Notif]', e.message)
  }
}

// ── Recontacto cron (cada 5 min) ─────────────────────────────────────
cron.schedule('*/5 * * * *', async () => {
  if (!activeSock || connectionStatus !== 'connected') return
  try {
    const settings = await db.getAISettings().catch(() => null)
    // Desactivado por defecto. Solo actúa si el usuario activó explícitamente recontact_enabled
    if (!settings?.recontact_enabled) return

    const convs = await db.getConversationsForRecontact()
    for (const conv of convs) {
      const targetPhone = String(conv.phone || '').trim()
      // Filtros de protección: no recontactar grupos, broadcasts ni canales
      if (!targetPhone ||
          targetPhone.includes('broadcast') ||
          targetPhone.includes('@g.us') ||
          targetPhone.includes('newsletter') ||
          targetPhone === 'status') {
        await db.setRecontactSent(conv.conversation_id)
        continue
      }

      // Si hay whitelist activa, no recontactar números fuera de whitelist
      const ALLOWED = (settings?.allowed_phones?.length)
        ? settings.allowed_phones
        : (process.env.ALLOWED_PHONES || '').split(',').map(p => p.trim()).filter(Boolean)
      if (ALLOWED.length > 0 && !ALLOWED.includes(targetPhone)) {
        await db.setRecontactSent(conv.conversation_id)
        continue
      }

      const history = await db.getRecentMessages(conv.conversation_id, 10)
      const result  = await getAIReply({ text: '', hasImage: false, imageBuffer: null, hasAudio: false, audioBuffer: null, history, clientName: conv.name || conv.phone, agentTypeOverride: 'recontacto' })
      if (result.reply && !result.isError) {
        const isLid = conv.phone.length >= 14 && !conv.phone.startsWith('549');
        const targetJid = conv.jid || conv.contact_jid || (conv.phone.includes('@') ? conv.phone : (isLid ? `${conv.phone}@lid` : `${conv.phone}@s.whatsapp.net`))
        await activeSock.sendMessage(targetJid, { text: result.reply })
        await db.saveMessage(conv.conversation_id, 'ai', result.reply, 'recontacto')
        await db.setRecontactSent(conv.conversation_id)
        await createAndPushNotif('recontacto', 'Recontacto enviado', `Seguimiento automático a ${conv.name || conv.phone}`, { convId: conv.conversation_id, phone: conv.phone, name: conv.name })
        console.log(`[Recontacto] Enviado a ${conv.phone}`)
      }
    }
  } catch (e) {
    console.error('[Recontacto cron]', e.message)
  }
})

// ── HTTP Server ───────────────────────────────────────────────────────
const DASHBOARD_SECRET = process.env.DASHBOARD_SECRET || ''

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Dashboard-Key, X-Session-Token')
}

async function checkAuth(req, res) {
  // Legacy secret key
  if (DASHBOARD_SECRET && req.headers['x-dashboard-key'] === DASHBOARD_SECRET) return { role: 'superadmin', username: 'system' }
  if (!DASHBOARD_SECRET && !req.headers['x-session-token']) return { role: 'superadmin', username: 'system' }
  // Session token
  const token = req.headers['x-session-token']
  if (token) {
    const user = await db.getUserByToken(token).catch(() => null)
    if (user) return user
  }
  res.writeHead(401, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'Unauthorized' }))
  return null
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', () => { try { resolve(JSON.parse(body)) } catch { resolve({}) } })
  })
}

const server = http.createServer(async (req, res) => {
  setCORS(res)

  // Preflight CORS
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  const url = req.url.split('?')[0]

  // ── Endpoints públicos ───────────────────────────────────────────────

  if (url === '/health') {
    return json(res, {
      status: 'ok',
      uptime_minutes: Math.floor((Date.now() - startTime) / 60000),
      messages_processed: messageCount,
      restarts: restartCount,
      wa_status: connectionStatus,
      timestamp: new Date().toISOString()
    })
  }

  if (url === '/qr') {
    if (!latestQR) {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<h2 style="font-family:sans-serif;padding:40px">No hay QR — WhatsApp ya está conectado o esperando reconexión.</h2>')
      return
    }
    const qrImage = await QRCode.toDataURL(latestQR)
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(`<!DOCTYPE html><html><body style="display:flex;flex-direction:column;align-items:center;font-family:sans-serif;padding:40px">
      <h2>Escaneá con WhatsApp</h2>
      <img src="${qrImage}" style="width:300px;height:300px"/>
      <p>Abrí WhatsApp → Dispositivos vinculados → Vincular dispositivo</p>
      <p><small>Recargá si expiró</small></p>
    </body></html>`)
    return
  }

  // ── EDY Dashboard Assistant (público, sin auth) ───────────────────────

  if (url === '/api/assistant' && req.method === 'POST') {
    try {
      const { message, history = [] } = await parseBody(req)
      if (!message?.trim()) return json(res, { reply: '¿En qué te ayudo?' })

      const settings = await db.getAISettings().catch(() => null)
      const advisor = getAdvisorInfo(settings)
      const escalationMsg = advisor.link
        ? `contactar a un asesor o soporte técnico: ${advisor.link}`
        : 'contactar a un asesor de EDIFICA.'

      const SYSTEM = `Sos EDY, el asistente virtual del dashboard de AIWorker para EDIFICA.
Ayudás a los usuarios del sistema (administradores y asesores) a:
- Navegar el dashboard: Panel de Control, Conversaciones (inbox WhatsApp), Mi Negocio (productos/servicios/turnos), Agentes IA, Notificaciones, Usuarios
- Resolver problemas comunes: WhatsApp desconectado (ir a Panel → escanear QR), notificaciones que no llegan (revisar conexión SSE), imágenes que no se envían (verificar que el producto tenga "puede enviar imagen" activado y la imagen cargada), login que falla (verificar que el servidor Render esté activo — puede tardar 30s en iniciar)
- Explicar módulos: Conversaciones tiene inbox en tiempo real + toma de control manual; Agentes IA muestra los 5 agentes nativos (generalista, servicios, productos, cotización, redirección, planilla de medidas) más personalizados; Gestión de Turnos tiene calendario semanal/mensual; Notificaciones tiene SSE en tiempo real con filtros
- Diagnóstico: si el usuario reporta que algo no funciona, pedile que te describa qué ve, qué intentó y el error si hay uno
- Escalado: si no podés resolver el problema en 2-3 intentos, recomendá ${escalationMsg}

Respondé en español rioplatense, mensajes cortos y claros. Sé amigable pero directo. Si el problema es técnico y complejo, decí honestamente qué podés y qué no podés resolver remotamente.`

      // EDY assistant using createGroqChat (Groq + Gemini fallback)
      const messages = [
        { role: 'system', content: SYSTEM },
        ...history.slice(-6).map(m => ({ role: m.role, content: m.content || m.text || '' })),
        { role: 'user', content: message }
      ]
      const r = await createGroqChat(messages, 250, 0.5)
      return json(res, { reply: r.choices[0].message.content })
    } catch (err) {
      console.error('[Assistant]', err.message)
      const settings = await db.getAISettings().catch(() => null)
      const advisor = getAdvisorInfo(settings)
      const fallbackHelp = advisor.link ? `\n\nPodés contactar al asesor aquí:\n${advisor.link}` : ''
      return json(res, { reply: `Tuve un problema técnico.${fallbackHelp}` })
    }
  }

  // ── Auth público ─────────────────────────────────────────────────────

  if (url === '/api/auth/login' && req.method === 'POST') {
    try {
      const { username, password } = await parseBody(req)
      if (!username || !password) return json(res, { error: 'Credenciales requeridas' }, 400)
      const user = await db.loginUser(username, password)
      if (!user) return json(res, { error: 'Usuario o contraseña incorrectos' }, 401)
      await db.logActivity(user.id, user.username, 'login', { ip: req.socket?.remoteAddress })
      return json(res, { ok: true, user: { id: user.id, username: user.username, name: user.name, role: user.role }, token: user.token })
    } catch (err) {
      return json(res, { error: err.message }, 500)
    }
  }

  // ── GET /api/users/me — validate session token (protected via token only) ─
  if (url === '/api/users/me' && req.method === 'GET') {
    const token = req.headers['x-session-token']
    if (!token) return json(res, { error: 'No token' }, 401)
    const user = await db.getUserByToken(token).catch(() => null)
    if (!user) return json(res, { error: 'Invalid token' }, 401)
    return json(res, { user })
  }

  // ── Endpoints protegidos (Dashboard API) ─────────────────────────────

  const authUser = await checkAuth(req, res)
  if (!authUser) return

  // GET /api/status
  if (url === '/api/status' && req.method === 'GET') {
    return json(res, {
      wa_status: connectionStatus,
      uptime_minutes: Math.floor((Date.now() - startTime) / 60000),
      messages_processed: messageCount,
      restarts: restartCount,
    })
  }

  // GET /api/qr — QR como base64 JSON para el dashboard
  if (url === '/api/qr' && req.method === 'GET') {
    if (!latestQR) {
      return json(res, { hasQR: false, status: connectionStatus })
    }
    const qrImage = await QRCode.toDataURL(latestQR)
    return json(res, { hasQR: true, qrImage, status: connectionStatus })
  }

  // GET /api/stats
  if (url === '/api/stats' && req.method === 'GET') {
    try {
      const stats = await db.getStats()
      return json(res, {
        ...stats,
        uptime_minutes: Math.floor((Date.now() - startTime) / 60000),
        messages_processed: messageCount,
        restarts: restartCount,
        wa_status: connectionStatus,
      })
    } catch (err) {
      return json(res, { error: err.message }, 500)
    }
  }

  // GET /api/stats/weekly
  if (url === '/api/stats/weekly' && req.method === 'GET') {
    try {
      const data = await db.getWeeklyActivity()
      return json(res, { data })
    } catch (err) {
      return json(res, { error: err.message }, 500)
    }
  }

  // GET /api/stats/hourly
  if (url === '/api/stats/hourly' && req.method === 'GET') {
    try {
      const data = await db.getHourlyActivity()
      return json(res, { data })
    } catch (err) {
      return json(res, { error: err.message }, 500)
    }
  }

  // GET /api/conversations
  if (url === '/api/conversations' && req.method === 'GET') {
    try {
      const conversations = await db.getConversations()
      return json(res, { conversations })
    } catch (err) {
      return json(res, { error: err.message }, 500)
    }
  }

  // GET /api/conversations/:id/messages
  const convMsgMatch = url.match(/^\/api\/conversations\/(\d+)\/messages$/)
  if (convMsgMatch && req.method === 'GET') {
    try {
      const messages = await db.getMessages(parseInt(convMsgMatch[1]))
      return json(res, { messages })
    } catch (err) {
      return json(res, { error: err.message }, 500)
    }
  }

  // GET /api/settings
  if (url === '/api/settings' && req.method === 'GET') {
    try {
      const settings = await db.getAISettings()
      return json(res, { settings })
    } catch (err) {
      return json(res, { error: err.message }, 500)
    }
  }

  // PUT /api/settings
  if (url === '/api/settings' && req.method === 'PUT') {
    try {
      const body = await parseBody(req)
      const settings = await db.updateAISettings(body)
      console.log('[Config] Configuración actualizada desde el dashboard')
      return json(res, { ok: true, settings })
    } catch (err) {
      return json(res, { error: err.message }, 500)
    }
  }

  // ── Products CRUD ────────────────────────────────────────────────

  // GET /api/products
  if (url === '/api/products' && req.method === 'GET') {
    try {
      const products = await db.getProducts()
      return json(res, { products })
    } catch (err) {
      return json(res, { error: err.message }, 500)
    }
  }

  // POST /api/products
  if (url === '/api/products' && req.method === 'POST') {
    try {
      const body = await parseBody(req)
      const product = await db.createProduct(body)
      // Save images if provided
      if (body.images?.length) {
        for (const img of body.images) {
          if (img.src) await db.addProductImage(product.id, img.src, img.name || null)
        }
      }
      console.log(`[Productos] Creado: ${product.name}`)
      return json(res, { ok: true, product })
    } catch (err) {
      return json(res, { error: err.message }, 500)
    }
  }

  // PUT /api/products/:id
  const prodMatch = url.match(/^\/api\/products\/(\d+)$/)
  if (prodMatch && req.method === 'PUT') {
    try {
      const body = await parseBody(req)
      const id = parseInt(prodMatch[1])
      const product = await db.updateProduct(id, body)
      // New images (have src but no id) → insert
      if (Array.isArray(body.images)) {
        for (const img of body.images) {
          if (img.src && !img.id) await db.addProductImage(id, img.src, img.name || null)
        }
      }
      console.log(`[Productos] Actualizado: ${product?.name}`)
      return json(res, { ok: true, product })
    } catch (err) {
      return json(res, { error: err.message }, 500)
    }
  }

  // DELETE /api/products/:id
  if (prodMatch && req.method === 'DELETE') {
    try {
      await db.deleteProduct(parseInt(prodMatch[1]))
      return json(res, { ok: true })
    } catch (err) {
      return json(res, { error: err.message }, 500)
    }
  }

  // ── Catalog images CRUD ──────────────────────────────────────────

  // GET /api/catalog
  if (url === '/api/catalog' && req.method === 'GET') {
    try {
      const images = await db.getCatalogImages()
      return json(res, { images })
    } catch (err) {
      return json(res, { error: err.message }, 500)
    }
  }

  // POST /api/catalog
  if (url === '/api/catalog' && req.method === 'POST') {
    try {
      const body = await parseBody(req)
      if (!body.name || !body.image_data) return json(res, { error: 'name e image_data requeridos' }, 400)
      const image = await db.addCatalogImage(body)
      console.log(`[Catálogo] Imagen agregada: ${body.name}`)
      return json(res, { ok: true, image })
    } catch (err) {
      return json(res, { error: err.message }, 500)
    }
  }

  // PUT /api/catalog/:id
  const catEditMatch = url.match(/^\/api\/catalog\/(\d+)$/)
  if (catEditMatch && req.method === 'PUT') {
    try {
      const body = await parseBody(req)
      const image = await db.updateCatalogImage(parseInt(catEditMatch[1]), body)
      return json(res, { ok: true, image })
    } catch (err) {
      return json(res, { error: err.message }, 500)
    }
  }

  // DELETE /api/catalog/:id
  const catDelMatch = url.match(/^\/api\/catalog\/(\d+)$/)
  if (catDelMatch && req.method === 'DELETE') {
    try {
      await db.deleteCatalogImage(parseInt(catDelMatch[1]))
      return json(res, { ok: true })
    } catch (err) {
      return json(res, { error: err.message }, 500)
    }
  }

  // ── Users CRUD ───────────────────────────────────────────────────

  // GET /api/users
  if (url === '/api/users' && req.method === 'GET') {
    try {
      const users = await db.getUsers()
      return json(res, { users })
    } catch (err) { return json(res, { error: err.message }, 500) }
  }

  // POST /api/users
  if (url === '/api/users' && req.method === 'POST') {
    try {
      const body = await parseBody(req)
      if (!body.username || !body.password) return json(res, { error: 'username y password requeridos' }, 400)
      const user = await db.createUser(body)
      await db.logActivity(authUser.id, authUser.username, 'crear_usuario', { username: body.username, role: body.role })
      return json(res, { ok: true, user })
    } catch (err) { return json(res, { error: err.message }, 500) }
  }

  // PUT /api/users/:id
  const userMatch = url.match(/^\/api\/users\/(\d+)$/)
  if (userMatch && req.method === 'PUT') {
    try {
      const body = await parseBody(req)
      const user = await db.updateUser(parseInt(userMatch[1]), body)
      await db.logActivity(authUser.id, authUser.username, 'editar_usuario', { id: userMatch[1] })
      return json(res, { ok: true, user })
    } catch (err) { return json(res, { error: err.message }, 500) }
  }

  // DELETE /api/users/:id
  if (userMatch && req.method === 'DELETE') {
    try {
      await db.deleteUser(parseInt(userMatch[1]))
      await db.logActivity(authUser.id, authUser.username, 'eliminar_usuario', { id: userMatch[1] })
      return json(res, { ok: true })
    } catch (err) { return json(res, { error: err.message }, 500) }
  }

  // ── Activity log ─────────────────────────────────────────────────

  // GET /api/activity
  if (url === '/api/activity' && req.method === 'GET') {
    try {
      const logs = await db.getActivityLog(200)
      return json(res, { logs })
    } catch (err) { return json(res, { error: err.message }, 500) }
  }

  // POST /api/activity
  if (url === '/api/activity' && req.method === 'POST') {
    try {
      const { action, details } = await parseBody(req)
      await db.logActivity(authUser.id, authUser.username, action, details)
      return json(res, { ok: true })
    } catch (err) { return json(res, { error: err.message }, 500) }
  }

  // ── Conversations send ───────────────────────────────────────────
  // POST /api/conversations/:id/send
  const convSendMatch = url.match(/^\/api\/conversations\/(\d+)\/send$/)
  if (convSendMatch && req.method === 'POST') {
    try {
      const { message } = await parseBody(req)
      const convId = parseInt(convSendMatch[1])
      if (!message?.trim()) return json(res, { error: 'Mensaje vacío' }, 400)
      if (!activeSock || connectionStatus !== 'connected') return json(res, { error: 'WhatsApp no conectado' }, 503)
      const conv = await db.getConversationWithContact(convId)
      if (!conv) return json(res, { error: 'Conversación no encontrada' }, 404)
      const isLid = conv.phone.length >= 14 && !conv.phone.startsWith('549');
      const targetJid = conv.jid || conv.contact_jid || (conv.phone.includes('@') ? conv.phone : (isLid ? `${conv.phone}@lid` : `${conv.phone}@s.whatsapp.net`))
      await activeSock.sendMessage(targetJid, { text: message.trim() })
      await db.saveMessage(convId, 'human', message.trim(), 'human', null, 'text')
      await db.logActivity(authUser.id, authUser.username, 'mensaje_manual', { convId, phone: conv.phone, preview: message.substring(0, 50) })
      await createAndPushNotif('human_msg', 'Mensaje manual enviado', `${authUser.name || authUser.username} → ${conv.name || conv.phone}: "${message.substring(0, 50)}"`, { convId, phone: conv.phone })
      return json(res, { ok: true })
    } catch (err) { return json(res, { error: err.message }, 500) }
  }

  // ── Planillas de Medidas ──────────────────────────────────────────
  // GET /api/planillas
  if (url === '/api/planillas' && req.method === 'GET') {
    try {
      const planillas = await db.getPlanillasMedidas(50)
      return json(res, { planillas })
    } catch (err) { return json(res, { error: err.message }, 500) }
  }

  // GET /api/conversations/:id/planilla
  const convPlanillaMatch = url.match(/^\/api\/conversations\/(\d+)\/planilla$/)
  if (convPlanillaMatch && req.method === 'GET') {
    try {
      const planilla = await db.getPlanillaByConvId(parseInt(convPlanillaMatch[1]))
      return json(res, { planilla })
    } catch (err) { return json(res, { error: err.message }, 500) }
  }

  // POST /api/conversations/:id/pause
  const convPauseMatch = url.match(/^\/api\/conversations\/(\d+)\/pause$/)
  if (convPauseMatch && req.method === 'POST') {
    try {
      const { paused } = await parseBody(req)
      const convId = parseInt(convPauseMatch[1])
      await db.setBotPaused(convId, !!paused)
      return json(res, { ok: true })
    } catch (err) { return json(res, { error: err.message }, 500) }
  }

  // DELETE /api/conversations/:id (Eliminar conversación)
  const convDeleteMatch = url.match(/^\/api\/conversations\/(\d+)$/)
  if (convDeleteMatch && req.method === 'DELETE') {
    try {
      const convId = parseInt(convDeleteMatch[1])
      await db.deleteConversation(convId)
      await db.logActivity(authUser.id, authUser.username, 'eliminar_conversacion', { convId })
      return json(res, { ok: true, deleted: convId })
    } catch (err) { return json(res, { error: err.message }, 500) }
  }

  // GET /api/planillas/:id/pdf (Descargar PDF oficial de planilla de medidas)
  const planillaPdfMatch = url.match(/^\/api\/planillas\/(\d+)\/pdf$/)
  if (planillaPdfMatch && req.method === 'GET') {
    try {
      const id = parseInt(planillaPdfMatch[1])
      const planilla = await db.getPlanillaById(id).catch(() => null)
      if (!planilla || !planilla.pdf_base64) return json(res, { error: 'PDF no disponible' }, 404)
      const pdfBuf = Buffer.from(planilla.pdf_base64, 'base64')
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="Planilla_Medidas_${String(planilla.obra || id).replace(/[^a-zA-Z0-9]/g, '_')}.pdf"`,
        'Content-Length': pdfBuf.length
      })
      res.end(pdfBuf)
      return
    } catch (err) { return json(res, { error: err.message }, 500) }
  }

  // ── Notifications ────────────────────────────────────────────────
  // GET /api/notifications
  if (url === '/api/notifications' && req.method === 'GET') {
    try {
      const notifications = await db.getNotifications(100)
      const unread = await db.getUnreadCount()
      return json(res, { notifications, unread })
    } catch (err) { return json(res, { error: err.message }, 500) }
  }

  // PUT /api/notifications/read-all
  if (url === '/api/notifications/read-all' && req.method === 'PUT') {
    try {
      await db.markAllNotificationsRead()
      return json(res, { ok: true })
    } catch (err) { return json(res, { error: err.message }, 500) }
  }

  // PUT /api/notifications/:id/read
  const notifReadMatch = url.match(/^\/api\/notifications\/(\d+)\/read$/)
  if (notifReadMatch && req.method === 'PUT') {
    try {
      await db.markNotificationRead(parseInt(notifReadMatch[1]))
      return json(res, { ok: true })
    } catch (err) { return json(res, { error: err.message }, 500) }
  }

  // GET /api/notifications/stream — SSE para notificaciones en tiempo real
  if (url === '/api/notifications/stream' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    })
    notifClients.add(res)
    const keepAlive = setInterval(() => res.write(':ping\n\n'), 25000)
    req.on('close', () => { notifClients.delete(res); clearInterval(keepAlive) })
    return
  }

  // ── Appointments ─────────────────────────────────────────────────
  // GET /api/appointments?from=YYYY-MM-DD&to=YYYY-MM-DD
  if (url.startsWith('/api/appointments') && req.method === 'GET') {
    const apptMatch = url.match(/^\/api\/appointments\/(\d+)$/)
    if (apptMatch) {
      try {
        const a = await db.getAppointment(parseInt(apptMatch[1]))
        if (!a) return json(res, { error: 'No encontrado' }, 404)
        return json(res, { appointment: a })
      } catch (err) { return json(res, { error: err.message }, 500) }
    }
    try {
      const params = new URL(url, 'http://x').searchParams
      const appts = await db.getAppointments({ from: params.get('from'), to: params.get('to') })
      return json(res, { appointments: appts })
    } catch (err) { return json(res, { error: err.message }, 500) }
  }

  // POST /api/appointments
  if (url === '/api/appointments' && req.method === 'POST') {
    try {
      const data = await parseBody(req)
      if (!data.service || !data.appt_date || !data.time_start) return json(res, { error: 'Faltan campos: service, appt_date, time_start' }, 400)
      data.agent_name = data.agent_name || authUser.name || authUser.username
      const appt = await db.createAppointment(data)
      await db.logActivity(authUser.id, authUser.username, 'crear_turno', { apptId: appt.id, service: appt.service, date: appt.appt_date })
      // Notificar al asesor por WhatsApp
      if (activeSock && connectionStatus === 'connected') {
        const msg = `📅 *Nuevo turno agendado*\n\nServicio: ${appt.service}\nFecha: ${appt.appt_date}\nHorario: ${appt.time_start}\nDuración: ${appt.duration}min\nAgente: ${appt.agent_name || '-'}\nNotas: ${appt.notes || '-'}\n\n⏰ ${new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}`
        const settings = await db.getAISettings().catch(() => null)
        const advisorInfo = getAdvisorInfo(settings)
        const notifyPhone = settings?.admin_phone || process.env.ADMIN_PHONE || advisorInfo.phone
        if (notifyPhone) {
          try { await activeSock.sendMessage(`${String(notifyPhone).replace(/[^0-9]/g, '')}@s.whatsapp.net`, { text: msg }) } catch {}
        }
      }
      await createAndPushNotif('turno', 'Turno agendado', `${appt.service} — ${appt.appt_date} ${appt.time_start}`, { apptId: appt.id })
      return json(res, { ok: true, appointment: appt })
    } catch (err) { return json(res, { error: err.message }, 500) }
  }

  // PUT /api/appointments/:id
  const apptEditMatch = url.match(/^\/api\/appointments\/(\d+)$/)
  if (apptEditMatch && req.method === 'PUT') {
    try {
      const data = await parseBody(req)
      const appt = await db.updateAppointment(parseInt(apptEditMatch[1]), data)
      return json(res, { ok: true, appointment: appt })
    } catch (err) { return json(res, { error: err.message }, 500) }
  }

  // DELETE /api/appointments/:id
  if (apptEditMatch && req.method === 'DELETE') {
    try {
      await db.deleteAppointment(parseInt(apptEditMatch[1]))
      return json(res, { ok: true })
    } catch (err) { return json(res, { error: err.message }, 500) }
  }

  // GET /logs/stream — SSE en tiempo real
  if (url === '/logs/stream' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    })

    // Enviar historial reciente
    for (const entry of logBuffer) {
      res.write(`data: ${JSON.stringify(entry)}\n\n`)
    }

    // Agregar cliente a la lista de streaming
    logClients.add(res)

    // Keepalive cada 25s
    const keepAlive = setInterval(() => res.write(':ping\n\n'), 25000)

    req.on('close', () => {
      logClients.delete(res)
      clearInterval(keepAlive)
    })
    return
  }

  res.writeHead(404)
  res.end()
})

server.listen(process.env.PORT || 3000, () => {
  console.log(`AIWorker corriendo en puerto ${process.env.PORT || 3000}`)
})

// ── Reporte diario 9am Argentina ──────────────────────────────────────
cron.schedule('0 12 * * *', async () => {
  try {
    const stats = await db.getStats()
    const uptimeHrs = Math.floor((Date.now() - startTime) / 3600000)
    await sendAdminAlert(
      `*Reporte diario*\n` +
      `Mensajes hoy: ${stats.messages_24h}\n` +
      `Contactos totales: ${stats.total_contacts}\n` +
      `Mensajes totales: ${stats.total_messages}\n` +
      `Uptime: ${uptimeHrs}hs\n` +
      `Reinicios: ${restartCount}\n` +
      `Estado: ${connectionStatus}`
    )
  } catch (err) {
    console.error('Error enviando reporte diario:', err.message)
  }
}, { timezone: 'America/Argentina/Buenos_Aires' })

// ── Alerta RAM ────────────────────────────────────────────────────────
setInterval(async () => {
  const used = process.memoryUsage().heapUsed / 1024 / 1024
  const total = 512
  const pct = Math.round((used / total) * 100)
  if (pct > 70) {
    await sendAdminAlert(
      `*Alerta de RAM*\nUso: ${used.toFixed(0)}MB / ${total}MB (${pct}%)\nConsidera el plan pago.`
    )
  }
}, 1000 * 60 * 30)

// ── Arrancar ──────────────────────────────────────────────────────────
console.log('Iniciando worker de WhatsApp...')
connectToWhatsApp()

// Ping interno cada 13 min
cron.schedule('*/13 * * * *', () => {
  http.get('http://localhost:' + (process.env.PORT || 3000), (res) => {
    console.log('[Ping] Toque interno enviado. Status:', res.statusCode)
  }).on('error', (err) => {
    console.error('[Ping Error]', err.message)
  })
})
