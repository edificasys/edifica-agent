import Groq from 'groq-sdk'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { createReadStream } from 'fs'
import { writeFile, unlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { db } from './db.js'

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)

// ── Detección de tipo de agente (sin API call extra) ─────────────
function detectAgentType(text, settings) {
  const t = (text || '').toLowerCase()

  if (settings?.custom_agents && Array.isArray(settings.custom_agents)) {
    for (const ca of settings.custom_agents) {
      if (ca.keywords && Array.isArray(ca.keywords)) {
        if (ca.keywords.some(kw => t.includes(kw.toLowerCase()))) {
          return ca.name
        }
      }
    }
  }

  // Redirección — máxima prioridad
  if (/hablar con (un |una )?(persona|asesor|humano|alguien|vendedor|representante)|quiero (ser |)atendid|me comunic[ae]|derivame|pasame|un asesor|necesito (que me llamen|hablar con alguien)|llamarme|hablen conmigo|quiero contactarme/.test(t))
    return 'redireccion'

  // Productos y marcas
  if (/piatti|portón|abertura|ventana|puerta (de aluminio|de pvc|levadiza)|pvc|aluminio|liv\b|sill[oó]n|silla|mesa (de )?comedor|mueble|mobiliario|interia|cocina (a medida|dise[ñn])|vestidor|closet|escalera|madera|vidrio/.test(t))
    return 'productos'

  // Cotizaciones y presupuestos
  if (/presupuesto|cotiz|precio|cu[aá]nto (cuesta|val[ei]|cobran|me sale)|costo|tarifa|cuota|financ/.test(t))
    return 'cotizacion'

  // Servicios de construcción
  if (/reforma|remodelar|remodelaci[oó]n|impermeabiliz|membrana|gotera|humedad|filtrac|estructura|hormig[oó]n|metal[iu]rg|pintura|terminaci[oó]n|obra|alba[ñn]il|revoque|contrapiso|yeso|piso|cer[aá]mico|porcelanato/.test(t))
    return 'servicios'

  return 'generalista'
}

// ── Prompts especializados por agente ────────────────────────────
const SIZES_CONTEXT = `
⚠️ MEDIDAS: Todos los productos que mostramos son en medidas ESTÁNDAR de fábrica. Si el cliente pide medidas diferentes o modificaciones: 1) Mencioná las medidas estándar disponibles, 2) Si insiste en medidas personalizadas, informale que es posible pero requiere una visita o consulta con el asesor, 3) Invitalo al showroom (Mauricio Yadarola 795, Córdoba, L-V 9-18hs) o derivalo con el asesor para concretar.`

const AGENT_PROMPTS = {
  generalista: `Sos EDY, asistente de EDIFICA Obras y Servicios (Córdoba, Argentina). Respondé saludos, preguntas generales y orientá al cliente hacia el servicio o producto correcto. Si el cliente no sabe bien qué necesita, hacé una pregunta para entender mejor. Sé breve, cálido y en argentino.${SIZES_CONTEXT}`,

  servicios: `Sos el especialista en servicios de construcción de EDIFICA. Conocés en detalle: Reformas Integrales, Impermeabilización, Estructuras, Pintura y Terminaciones, y Obras Generales. Cuando te consulten por un servicio, explicá en qué consiste, ofrecé una orientación de precio (si la tenés en el catálogo) y siempre invitá a solicitar una visita o presupuesto sin cargo. Sé técnico pero accesible.${SIZES_CONTEXT}`,

  productos: `Sos el asesor de productos de EDIFICA. Manejás las marcas: PIATTI (aberturas PVC y aluminio, portones levadizos — distribuidor oficial con garantía de fábrica), LIV (mobiliario: sillones, sillas, comedor), INTERIA (cocinas y vestidores a medida), Escaleras a Medida (madera, metal y vidrio). Para productos físicos, invitá siempre a visitar el showroom en Mauricio Yadarola 795, Córdoba (L-V 9-18hs) o pedir catálogo por WhatsApp. Cuando el cliente pida imágenes o fotos, describí brevemente el producto y decile que "a continuación te muestro una imagen" — el sistema la envía automáticamente. NUNCA uses frases como [envía fotos], [enviando imagen], [ver fotos] ni ninguna acción entre corchetes. NUNCA simules enviar archivos.${SIZES_CONTEXT}`,

  cotizacion: `Sos el agente de cotizaciones de EDIFICA. Tu objetivo es capturar la consulta del cliente para que un asesor pueda contactarlo con un presupuesto a medida. Preguntá: qué necesita, en qué zona está, cuándo quiere iniciar. Al final siempre ofrecé: "Te contactamos en las próximas horas para darte una cotización exacta. ¿Querés dejarnos tus datos o preferís escribirnos a contactanos@edifica.com?". También podés dar rangos orientativos si los tenés.${SIZES_CONTEXT}`,

  redireccion: `Sos el agente de derivación de EDIFICA. El cliente quiere hablar con un asesor humano. Tu respuesta debe: 1) Agradecerle por su consulta, 2) Dar el link de WhatsApp del asesor: https://wa.me/543516002716, 3) Decirle que el asesor ya tiene el resumen de su consulta y lo va a atender rápido. Sé cálido y breve.`,

  recontacto: `Sos EDY, asistente de EDIFICA. Estás retomando una conversación con un cliente que quedó inconclusa. Tu objetivo es: 1) Saludar cordialmente recordándoles que habían hablado antes, 2) Preguntar si pudo avanzar o si necesita algo más, 3) Si estaba esperando información, ofrecele nueva ayuda o derivalo con un asesor. Sé breve, cálido y no insistente.`,
}

// ── Construir system prompt completo ────────────────────────────
async function buildSystemPrompt(agentType, settings) {
  // Use DB agent prompt override if the admin customized it, otherwise use defaults
  const agentOverride = settings.agent_prompts?.[agentType]
  let base = agentOverride || AGENT_PROMPTS[agentType] || AGENT_PROMPTS.generalista

  if (settings.custom_agents && Array.isArray(settings.custom_agents)) {
    const ca = settings.custom_agents.find(a => a.name === agentType)
    if (ca) base = ca.prompt || ''
  }

  if (agentType === 'redireccion' && !agentOverride) {
    if (settings.advisors && settings.advisors.length > 0) {
      const advList = settings.advisors.map(a => `- ${a.name || 'Asesor'} (Especialidad: ${a.role || 'General'}): https://wa.me/${a.phone}`).join('\n')
      base = `Sos el agente de derivación de EDIFICA. El cliente quiere hablar con un asesor humano. Tu respuesta debe: 1) Agradecerle por su consulta, 2) Elegir al asesor más adecuado para su caso y darle su link de WhatsApp. Opciones de asesores:\n${advList}\n\nSolo podés pasar UN link. 3) Decirle que el asesor ya tiene el resumen de su consulta y lo va a atender rápido. Sé cálido y breve.`
    } else if (settings.redirect_phone) {
      base = base.replace(/543516002716/g, settings.redirect_phone).replace(/5493516002716/g, settings.redirect_phone)
    }
  }

  const businessCtx = `\nNegocio: ${settings.business_description || 'EDIFICA Obras y Servicios, Córdoba'}
📍 Showroom: Mauricio Yadarola 795 | ⏰ L-V 9-18hs | 📧 contactanos@edifica.com | 📱 +54 9 3518 00-7584`

  // Product catalogue
  let productContext = ''
  try {
    const products = await db.getActiveProducts()
    if (products.length > 0) {
      const prodBlock = products.map(p => {
        let info = `• ${p.name} [${p.category}]`
        if (p.price) info += ` — ${p.price}`
        if (p.description) info += `\n  ${p.description}`
        if (p.ai_when) info += `\n  Activar cuando: ${p.ai_when}`
        if (p.ai_how) info += `\n  Cómo responder: ${p.ai_how}`
        if (p.keywords?.length) info += `\n  Palabras clave: ${p.keywords.join(', ')}`
        return info
      }).join('\n\n')
      productContext = `\n\n━━━ CATÁLOGO EDIFICA ━━━\n${prodBlock}\n\nUsá esta info con precisión. No inventes nada que no esté listado.`
    }
  } catch (err) {
    console.error('[AI] Error cargando catálogo:', err.message)
  }

  // FAQs
  let faqContext = ''
  try {
    const faqs = Array.isArray(settings.faqs) ? settings.faqs : []
    if (faqs.length > 0) {
      const faqBlock = faqs.map(f => `P: ${f.q}\nR: ${f.a}`).join('\n\n')
      faqContext = `\n\n━━━ PREGUNTAS FRECUENTES ━━━\n${faqBlock}`
    }
  } catch {}

  const personalityCtx = settings.personality_prompt ? `\n\n━━━ TU PERSONALIDAD ━━━\n${settings.personality_prompt}` : ''
  const restrictionsCtx = settings.restrictions ? `\n\n━━━ RESTRICCIONES (NO HACER) ━━━\n${settings.restrictions}` : ''
  const goalsCtx = settings.goals ? `\n\n━━━ TUS OBJETIVOS ━━━\n${settings.goals}` : ''

  return `${base}${businessCtx}${productContext}${faqContext}${personalityCtx}${restrictionsCtx}${goalsCtx}\n\nReglas: Respondé en español rioplatense, mensajes cortos y claros (WhatsApp), nunca inventes precios exactos sin visita previa. NUNCA uses frases entre corchetes como [envía fotos] ni simules acciones.`
}

// ── Generar resumen de conversación para el asesor ───────────────
async function generateSummary(history, lastText, clientName) {
  const historyText = history.map(m =>
    `${m.sender === 'client' ? 'Cliente' : 'Bot'}: ${m.content}`
  ).join('\n')

  try {
    const messages = [
      { role: 'system', content: 'Generá un resumen breve (3-5 líneas) en español de lo que consultó el cliente y por qué quiere hablar con un asesor. Sé directo y útil para el vendedor.' },
      { role: 'user', content: `Cliente: ${clientName}\nÚltimo mensaje: "${lastText}"\n\nHistorial:\n${historyText}` }
    ]
    let r;
    try {
      r = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages,
        max_tokens: 200,
        temperature: 0.3,
      })
    } catch (e) {
      if (e.status === 429) {
        r = await groq.chat.completions.create({
          model: 'llama-3.1-8b-instant',
          messages,
          max_tokens: 200,
          temperature: 0.3,
        })
      } else throw e;
    }
    return r.choices[0].message.content
  } catch {
    return lastText || 'El cliente solicitó hablar con un asesor.'
  }
}

// ── Transcripción de audio (Groq Whisper) ────────────────────────
export async function transcribeAudio(audioBuffer, mimeType = 'audio/ogg') {
  const ext = mimeType.includes('mp4') ? 'm4a' : mimeType.includes('mpeg') ? 'mp3' : 'ogg'
  const tmpPath = join(tmpdir(), `wa_audio_${Date.now()}.${ext}`)
  try {
    await writeFile(tmpPath, audioBuffer)
    const result = await groq.audio.transcriptions.create({
      file: createReadStream(tmpPath),
      model: 'whisper-large-v3-turbo',
      response_format: 'text',
      language: 'es',
    })
    return typeof result === 'string' ? result.trim() : result.text?.trim() || ''
  } catch (err) {
    console.error('[Whisper] Error:', err.message)
    return ''
  } finally {
    try { await unlink(tmpPath) } catch {}
  }
}

// ── Buscar imagen de producto relevante ──────────────────────────
async function findProductImage(text, agentType) {
  if (!['productos', 'cotizacion'].includes(agentType)) return null
  try {
    const products = await db.getProducts()
    const t = (text || '').toLowerCase()
    for (const p of products) {
      if (!p.can_send_image) continue
      const kws = [...(p.keywords || []), p.name.toLowerCase(), p.category]
      if (kws.some(k => k && t.includes(k.toLowerCase()))) {
        const hasImg = p.images?.length > 0
        return {
          productId: p.id,
          productName: p.name,
          productDescription: p.description || null,
          imageData: hasImg ? p.images[0].data : null,
          imageName: hasImg ? p.images[0].name : null,
        }
      }
    }
  } catch {}
  return null
}

// ── Respuesta principal ──────────────────────────────────────────
export async function getAIReply({ text, hasImage, imageBuffer, hasAudio, audioBuffer, audioMime, history, clientName = '', agentTypeOverride = null, imagesSent = {}, isFirstMessage = false }) {
  const settings = await db.getAISettings()

  // Audio → transcribir primero
  if (hasAudio && audioBuffer) {
    const transcribed = await transcribeAudio(audioBuffer, audioMime)
    if (!transcribed) return {
      reply: 'Recibí tu audio pero no pude escucharlo bien. ¿Podés escribirme lo que necesitás?',
      agentType: 'generalista', isHandoff: false, summary: null
    }
    console.log(`[Whisper] "${transcribed.substring(0, 80)}"`)
    return getAIReply({ text: transcribed, hasImage: false, imageBuffer: null, history, clientName, imagesSent })
  }

  // Detectar tipo de agente
  const agentType = agentTypeOverride || detectAgentType(text, settings)
  const isHandoff = agentType === 'redireccion'

  // Imagen del cliente → Gemini analiza y describe
  if (hasImage && imageBuffer) {
    let reply = 'Recibí tu imagen. ¿Me contás más sobre lo que necesitás?'
    let imageDescription = null
    try {
      const systemPrompt = await buildSystemPrompt('servicios', settings)
      const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' })
      const imagePart = { inlineData: { data: imageBuffer.toString('base64'), mimeType: 'image/jpeg' } }
      // Descripción para el asesor (separada de la respuesta al cliente)
      const descResult = await model.generateContent([
        'Describí en 2-3 líneas qué se ve en esta imagen (materiales, tipo de obra, estado, colores). Sé objetivo y técnico. Solo la descripción, sin saludos.',
        imagePart
      ])
      imageDescription = descResult.response.text().trim()
      // Respuesta al cliente
      const chatResult = await model.generateContent([
        systemPrompt,
        imagePart,
        text || 'El cliente mandó esta imagen. Analizala, identificá qué se ve y respondé de forma útil para orientarlo.'
      ])
      reply = chatResult.response.text()
    } catch (err) {
      console.error('Error Gemini:', err.message)
    }
    return { reply, agentType: 'servicios', isHandoff: false, summary: null, imageDescription }
  }

  // Agente de redirección: generar resumen + respuesta de despedida
  if (isHandoff) {
    const summary = await generateSummary(history, text, clientName)
    const systemPrompt = await buildSystemPrompt('redireccion', settings)
    try {
      const messages = [
        { role: 'system', content: systemPrompt },
        ...history.map(m => ({ role: m.sender === 'ai' ? 'assistant' : 'user', content: m.content || '' })),
        { role: 'user', content: text || 'Quiero hablar con un asesor' }
      ];
      let r;
      try {
        r = await groq.chat.completions.create({
          model: 'llama-3.3-70b-versatile',
          messages,
          max_tokens: 200,
          temperature: 0.5,
        })
      } catch (e) {
        if (e.status === 429) {
          r = await groq.chat.completions.create({
            model: 'llama-3.1-8b-instant',
            messages,
            max_tokens: 200,
            temperature: 0.5,
          })
        } else throw e;
      }
      const replyText = r.choices[0].message.content
      const match = replyText.match(/wa\.me\/(\d+)/)
      const handoff_target = match ? match[1] : null
      return { reply: replyText, agentType: 'redireccion', isHandoff: true, summary, handoff_target }
    } catch {
      let defaultPhone = '543516002716'
      if (settings.advisors && settings.advisors.length > 0) defaultPhone = settings.advisors[0].phone
      else if (settings.redirect_phone) defaultPhone = settings.redirect_phone
      const fallback = `¡Claro! Te conecto con un asesor de EDIFICA ahora mismo 👇\n\nhttps://wa.me/${defaultPhone}\n\nYa le avisé que venís a consultar — te atiende en breve. 🙌`
      return { reply: fallback, agentType: 'redireccion', isHandoff: true, summary, handoff_target: defaultPhone }
    }
  }

  // Contexto de imágenes ya enviadas en esta conversación
  const sentNames = Object.values(imagesSent).map(v => v.name).filter(Boolean)
  const defaultAdvPhone = settings.advisors?.[0]?.phone || settings.redirect_phone || '543516002716'
  const imagesCtx = sentNames.length > 0
    ? `\n\n⚠️ Ya enviaste imagen de: ${sentNames.join(', ')}. Si el cliente insiste en esos productos con medidas u otros detalles específicos, derivalo al asesor (https://wa.me/${defaultAdvPhone}) para atención personalizada. NO repitas la imagen.`
    : ''

  // Respuesta de texto normal con agente especializado
  const systemPrompt = await buildSystemPrompt(agentType, settings) + imagesCtx
  try {
    const messages = [
      { role: 'system', content: systemPrompt },
      ...history.map(m => ({ role: m.sender === 'ai' ? 'assistant' : 'user', content: m.content || '' })),
      { role: 'user', content: text || '' }
    ]

    const reinforcement = `\n\n[SISTEMA: REGLAS ESTRICTAS E INQUEBRANTABLES:
${settings.personality_prompt ? settings.personality_prompt : 'Sé muy breve y conciso.'}
${settings.restrictions ? `PROHIBIDO ESTRICTAMENTE: ${settings.restrictions}` : ''}
TU RESPUESTA NO DEBE SUPERAR BAJO NINGÚN CONCEPTO LAS 3 LÍNEAS DE TEXTO. No hagas listas largas ni mandes párrafos grandes de texto. Respondé la consulta de forma útil pero extremadamente corta.]`

    if (isFirstMessage && settings.welcome_message) {
      messages[messages.length - 1].content += `\n\n[SISTEMA: Este es el primer contacto del cliente. DEBES iniciar tu respuesta saludando EXACTAMENTE con este mensaje de bienvenida: "${settings.welcome_message}". Luego responde su consulta respetando la regla estricta de no superar las 3 líneas.]`
    } else {
      messages[messages.length - 1].content += reinforcement
    }
    let response;
    try {
      response = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages,
        max_tokens: 200,
        temperature: 0.5,
      })
    } catch (e) {
      if (e.status === 429) {
        response = await groq.chat.completions.create({
          model: 'llama-3.1-8b-instant',
          messages,
          max_tokens: 200,
          temperature: 0.5,
        })
      } else throw e;
    }
    let reply = response.choices[0].message.content

    // Limpiar cualquier tag residual entre corchetes
    reply = reply.replace(/\[[^\]]{0,60}\]/g, '').trim()

    // Detectar si el cliente pide imágenes
    const wantsImage = /foto|imagen|photo|picture|ver|mostrar|tenés foto|mandame|como queda|como se ve/i.test(text || '')
    const imageInfo = wantsImage ? await findProductImage(text, agentType) : null

    return { reply, agentType, isHandoff: false, summary: null, imageInfo }
  } catch (err) {
    console.error('Error Groq:', err.message)
    return { reply: 'Disculpá, tuve un problema técnico. Intentá de nuevo en un momento.', agentType, isHandoff: false, summary: null, imageInfo: null, isError: true }
  }
}
