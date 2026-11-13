import dotenv from 'dotenv'
dotenv.config()
import readline from 'readline'
import { getAIReply } from './src/ai.js'

// Simulador interactivo y automático de AIWorker
console.log('═══════════════════════════════════════════════════════════')
console.log('🤖 SIMULADOR INTERACTIVO DE AGENTE IA (EDIFICA / EDY)')
console.log('═══════════════════════════════════════════════════════════\n')

const hasGroq = !!process.env.GROQ_API_KEY

if (!hasGroq) {
  console.log('⚠️ AVISO: No se detectó GROQ_API_KEY en tu archivo .env local.')
  console.log('  En Render la key ya está configurada en producción.')
  console.log('  Si querés probar localmente con Groq, agregá tu key a .env:')
  console.log('  GROQ_API_KEY=gsk_...\n')
}

// Historial en memoria de la simulación
let history = []
const clientName = 'Gabriel Sánchez (Simulado)'

async function sendMessage(userText) {
  console.log(`\n👤 [Cliente]: "${userText}"`)
  console.log('⏳ Procesando respuesta del agente...')

  try {
    const result = await getAIReply({
      text: userText,
      hasImage: false,
      imageBuffer: null,
      hasAudio: false,
      audioBuffer: null,
      history,
      clientName,
      imagesSent: {},
      isFirstMessage: history.length === 0
    })

    console.log(`\n🏷️ [Agente Detectado]: ${result.agentType.toUpperCase()}`)
    console.log(`💬 [Respuesta de EDY]:\n${result.reply}\n`)

    if (result.isPlanillaHandoff) {
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
      console.log('📐 [EVENTO: PLANILLA DE MEDIDAS CONFIRMADA]')
      console.log('📲 Se enviaría al WhatsApp del Asesor el siguiente reporte:')
      console.log(`\n${result.summary || result.reply}\n`)
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    } else if (result.isHandoff) {
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
      console.log('📱 [EVENTO: DERIVACIÓN A ASESOR HUMANO]')
      console.log(`Resumen para el asesor: ${result.summary}`)
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    }

    // Agregar al historial para mantener contexto
    history.push({ sender: 'client', content: userText, agent_type: 'cliente' })
    history.push({ sender: 'ai', content: result.reply, agent_type: result.agentType })
  } catch (err) {
    console.error('❌ Error en simulación:', err.message)
  }
}

async function runDemoFlow() {
  console.log('🚀 Ejecutando demostración guiada del Agente de Medidas:\n')

  console.log('--- PASO 1: Consulta inicial sobre aberturas a medida ---')
  await sendMessage('Hola! Necesito hacer unas aberturas y vanos a medida para una casa')

  console.log('\n--- PASO 2: El cliente brinda los datos de obra y vanos ---')
  await sendMessage('La obra es para Gabriel Sánchez en V. Prado. Son 2 puertas placa: una para Baño de 2020 alto x 800 ancho x 190 profundidad abre a la izquierda, y otra para Dormitorio Principal de 2040 x 840 x 165 también abre a la izquierda.')

  console.log('\n--- PASO 3: El cliente confirma la planilla ---')
  await sendMessage('Sí, está perfecto. Confirmame el pedido')

  console.log('\n✅ Fin de la demostración guiada.\n')
}

// Menú principal
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

console.log('Seleccioná el modo de prueba:')
console.log('1. Ejecutar simulación automática guiada (Flujo Planilla de Medidas)')
console.log('2. Chatear libremente por consola como cliente de WhatsApp')
console.log('0. Salir\n')

rl.question('Opción (1/2/0): ', async (ans) => {
  const opt = ans.trim()
  if (opt === '1') {
    await runDemoFlow()
    rl.close()
  } else if (opt === '2') {
    console.log('\n💡 Escribí tu mensaje y presioná ENTER (escribí "salir" para terminar):\n')
    const promptUser = () => {
      rl.question('Escribir mensaje: ', async (txt) => {
        if (!txt.trim() || txt.toLowerCase() === 'salir') {
          console.log('Simulación finalizada.')
          rl.close()
          return
        }
        await sendMessage(txt)
        promptUser()
      })
    }
    promptUser()
  } else {
    rl.close()
  }
})
