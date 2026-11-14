import PDFDocument from 'pdfkit'

/**
 * Parsea el texto del chat o resumen de la planilla para extraer los campos estructurados
 */
export function parsePlanillaText(text = '', clientName = '') {
  const data = {
    obra: clientName || '',
    direccion: '',
    fecha: new Date().toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' }),
    relevo: clientName || 'CLIENTE',
    vanos: [],
    observaciones: ''
  }

  // 1. Extraer Obra
  const obraMatch = text.match(/(?:OBRA|Obra|Cliente):\s*([^\n\r*]+)/i)
  if (obraMatch && obraMatch[1].trim() && !obraMatch[1].includes('[')) {
    data.obra = obraMatch[1].trim()
  }

  // 2. Extraer Dirección
  const dirMatch = text.match(/(?:DIRECCI[OÓ]N|Direcci[oó]n|Domicilio|Ubicaci[oó]n):\s*([^\n\r*]+)/i)
  if (dirMatch && dirMatch[1].trim() && !dirMatch[1].includes('[')) {
    data.direccion = dirMatch[1].trim()
  }

  // 3. Extraer Relevó
  const relevoMatch = text.match(/(?:RELEV[OÓ]|Relev[oó]):\s*([^\n\r*]+)/i)
  if (relevoMatch && relevoMatch[1].trim() && !relevoMatch[1].includes('[')) {
    data.relevo = relevoMatch[1].trim()
  }

  // 4. Extraer Fecha
  const fechaMatch = text.match(/(?:FECHA|Fecha):\s*([0-9]{1,2}[\/\-][0-9]{1,2}[\/\-][0-9]{2,4})/i)
  if (fechaMatch && fechaMatch[1].trim()) {
    data.fecha = fechaMatch[1].trim()
  }

  // 5. Extraer Vanos (soporta formato estructurado y texto libre)
  // Formato structured: 01 | Baño ... Medidas: 2020 mm (alto) x 800 mm (ancho) x 190 mm (prof.) ... Apertura: IZQ
  const lines = text.split('\n')
  let currentVano = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    const vanoHeader = line.match(/^(?:0?([1-9]))\s*\|\s*([^*\n\r•]+)/)

    if (vanoHeader) {
      if (currentVano) data.vanos.push(currentVano)
      currentVano = {
        n: parseInt(vanoHeader[1]),
        ambiente: vanoHeader[2].trim(),
        alto: '',
        ancho: '',
        profundidad: '',
        apertura: 'IZQ'
      }
      continue
    }

    if (currentVano) {
      const medidasMatch = line.match(/([0-9]+)\s*(?:mm)?\s*\(?alto\)?\s*[×x*]\s*([0-9]+)\s*(?:mm)?\s*\(?ancho\)?(?:\s*[×x*]\s*([0-9]+)\s*(?:mm)?\s*\(?prof\w*\)?)?/i)
      if (medidasMatch) {
        currentVano.alto = medidasMatch[1]
        currentVano.ancho = medidasMatch[2]
        currentVano.profundidad = medidasMatch[3] || '150'
      }

      if (/apertura|sentido/i.test(line)) {
        if (/der/i.test(line)) currentVano.apertura = 'DER'
        else if (/izq/i.test(line)) currentVano.apertura = 'IZQ'
      }
    }
  }
  if (currentVano) data.vanos.push(currentVano)

  // Si no encontró con el parser estructurado, buscar patrones en todo el texto (ej: "2m x 1m" o "2000 x 1000")
  if (data.vanos.length === 0) {
    const rawMatches = [...text.matchAll(/(puerta|ventana|abertura|port[oó]n|baño|dormitorio|cocina|vano)[^0-9]*([0-9]+(?:\.[0-9]+)?)\s*(?:m|mm|cm)?\s*[x×*]\s*([0-9]+(?:\.[0-9]+)?)/gi)]
    let count = 1
    for (const m of rawMatches) {
      let dim1 = parseFloat(m[2])
      let dim2 = parseFloat(m[3])
      // Convertir metros a mm si vienen en metros (ej: 2m x 1m -> 2000 x 1000)
      if (dim1 < 10) dim1 = Math.round(dim1 * 1000)
      if (dim2 < 10) dim2 = Math.round(dim2 * 1000)

      const alto = Math.max(dim1, dim2)
      const ancho = Math.min(dim1, dim2)
      const apertura = /der/i.test(text) ? 'DER' : 'IZQ'

      data.vanos.push({
        n: count++,
        ambiente: m[1].toUpperCase(),
        alto: String(alto),
        ancho: String(ancho),
        profundidad: '150',
        apertura
      })
    }
  }

  // 6. Extraer Observaciones
  const obsMatch = text.match(/(?:OBSERVACIONES|Observaciones|Notas?):\s*([^\n\r*]+)/i)
  if (obsMatch && obsMatch[1].trim() && !obsMatch[1].includes('[')) {
    data.observaciones = obsMatch[1].trim()
  }

  return data
}

/**
 * Genera el Buffer del PDF con el diseño exacto de la "Planilla de Medidas - EDIFICA EQUIPAMIENTOS"
 */
export function generatePlanillaPDF(data) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4', // 595.28 x 841.89 pt
        margins: { top: 24, bottom: 24, left: 24, right: 24 }
      })

      const chunks = []
      doc.on('data', chunk => chunks.push(chunk))
      doc.on('end', () => resolve(Buffer.concat(chunks)))
      doc.on('error', err => reject(err))

      const pageWidth = 595.28
      const left = 24
      const right = pageWidth - 24
      const contentWidth = right - left // 547.28

      // ── 1. ENCABEZADO SUPERIOR (Fondo oscuro) ─────────────────────────
      doc.rect(left, 24, contentWidth, 58).fill('#1A1A1A')

      // Logo EDIFICA EQUIPAMIENTOS
      doc.fillColor('#FFFFFF')
        .font('Helvetica-Bold')
        .fontSize(24)
        .text('EDIFICA', left + 16, 32)

      doc.fillColor('#FFFFFF')
        .font('Helvetica-Bold')
        .fontSize(7.5)
        .text('E Q U I P A M I E N T O S', left + 16, 62)

      // Línea divisoria vertical en encabezado
      doc.strokeColor('#52525B')
        .lineWidth(1)
        .moveTo(left + 185, 32)
        .lineTo(left + 185, 72)
        .stroke()

      // Títulos derecha
      doc.fillColor('#FFFFFF')
        .font('Helvetica-Bold')
        .fontSize(16)
        .text('PLANILLA DE MEDIDAS', left + 195, 30, { width: contentWidth - 210, align: 'right' })

      doc.fillColor('#E4E4E7')
        .font('Helvetica')
        .fontSize(10.5)
        .text('Relevamiento de obra', left + 195, 50, { width: contentWidth - 210, align: 'right' })

      doc.fillColor('#A1A1AA')
        .font('Helvetica')
        .fontSize(8)
        .text('Diseño · Fabricación · Instalación', left + 195, 65, { width: contentWidth - 210, align: 'right' })

      // Franja dorada de acento
      doc.rect(left, 82, contentWidth, 5).fill('#C29B62')

      // ── 2. TÍTULO DE SECCIÓN ──────────────────────────────────────────
      doc.fillColor('#18181B')
        .font('Helvetica-Bold')
        .fontSize(20)
        .text('Medidas de vano', left, 96)

      doc.fillColor('#64748B')
        .font('Helvetica')
        .fontSize(9.5)
        .text('Registro simple para enviar a producción', left, 120)

      // ── 3. CAMPOS SUPERIORES (OBRA, FECHA, DIRECCIÓN, RELEVÓ) ────────
      const row1Y = 138
      const row2Y = 170

      const drawPillField = (label, value, x, y, labelW, boxW) => {
        doc.fillColor('#000000')
          .font('Helvetica-Bold')
          .fontSize(9.5)
          .text(label, x, y + 6)

        const boxX = x + labelW
        doc.roundedRect(boxX, y, boxW, 25, 5)
          .fillAndStroke('#FFFFFF', '#CBD5E1')

        if (value) {
          doc.fillColor('#1E3A8A')
            .font('Helvetica-Bold')
            .fontSize(10.5)
            .text(String(value).toUpperCase(), boxX + 8, y + 7, { width: boxW - 16, ellipsis: true })
        }
      }

      // Fila 1: OBRA y FECHA
      drawPillField('OBRA', data.obra || '', left, row1Y, 70, 240)
      drawPillField('FECHA', data.fecha || '', left + 325, row1Y, 55, 167)

      // Fila 2: DIRECCIÓN y RELEVÓ
      drawPillField('DIRECCIÓN', data.direccion || '', left, row2Y, 70, 240)
      drawPillField('RELEVÓ', data.relevo || '', left + 325, row2Y, 55, 167)

      // ── 4. FRANJA SUB-BANNER INFORMATIVA ──────────────────────────────
      const bannerY = 205
      doc.roundedRect(left, bannerY, contentWidth, 20, 4)
        .fill('#FEF7EE')

      doc.fillColor('#000000')
        .font('Helvetica-Bold')
        .fontSize(8.5)
        .text('MEDIDAS EN MILÍMETROS (mm)', left + 14, bannerY + 6)

      doc.fillColor('#64748B')
        .font('Helvetica')
        .fontSize(8.5)
        .text('|   Marcar IZQ. o DER. según la apertura', right - 220, bannerY + 6, { align: 'right', width: 210 })

      // ── 5. CABECERA DE TABLA ──────────────────────────────────────────
      const tableY = 232
      doc.rect(left, tableY, contentWidth, 25).fill('#1E293B')

      // Column widths and offsets
      // Total = 547: N°(35) + VANO(150) + ALTO(72) + ANCHO(72) + PROF(86) + APERTURA(132) = 547
      const colX = {
        n: left,
        vano: left + 35,
        alto: left + 185,
        ancho: left + 257,
        prof: left + 329,
        apert: left + 415
      }

      const drawHeaderCell = (text, x, w) => {
        doc.fillColor('#FFFFFF')
          .font('Helvetica-Bold')
          .fontSize(8.5)
          .text(text, x, tableY + 8, { width: w, align: 'center' })
      }

      drawHeaderCell('N°', colX.n, 35)
      drawHeaderCell('VANO / AMBIENTE', colX.vano, 150)
      drawHeaderCell('ALTO', colX.alto, 72)
      drawHeaderCell('ANCHO', colX.ancho, 72)
      drawHeaderCell('PROFUNDIDAD', colX.prof, 86)
      drawHeaderCell('SENTIDO DE APERTURA', colX.apert, 132)

      // ── 6. FILAS DE LA TABLA (8 FILAS: 01 a 08) ───────────────────────
      const startRowY = 262
      const rowHeight = 35

      const drawCheckSquare = (x, y, isChecked) => {
        doc.roundedRect(x, y, 12, 12, 2)
          .lineWidth(1)
          .strokeColor('#18181B')
          .stroke()

        if (isChecked) {
          // Dibujar checkmark ✓ azul
          doc.strokeColor('#1D4ED8')
            .lineWidth(2)
            .moveTo(x + 2.5, y + 6)
            .lineTo(x + 5, y + 9.5)
            .lineTo(x + 10, y + 2.5)
            .stroke()
        }
      }

      for (let i = 0; i < 8; i++) {
        const rowY = startRowY + (i * rowHeight)
        const item = data.vanos && data.vanos[i] ? data.vanos[i] : null
        const numStr = String(i + 1).padStart(2, '0')

        // Número de vano
        doc.fillColor('#000000')
          .font('Helvetica-Bold')
          .fontSize(11)
          .text(numStr, colX.n, rowY + 9, { width: 35, align: 'center' })

        // Celda VANO / AMBIENTE
        doc.roundedRect(colX.vano + 4, rowY + 3, 142, 26, 4)
          .fillAndStroke('#FFFFFF', '#CBD5E1')
        if (item?.ambiente) {
          doc.fillColor('#1E3A8A')
            .font('Helvetica-Bold')
            .fontSize(9.5)
            .text(String(item.ambiente).toUpperCase(), colX.vano + 8, rowY + 10, { width: 134, align: 'center', ellipsis: true })
        }

        // Celda ALTO
        doc.roundedRect(colX.alto + 4, rowY + 3, 64, 26, 4)
          .fillAndStroke('#FFFFFF', '#CBD5E1')
        if (item?.alto) {
          doc.fillColor('#1E3A8A')
            .font('Helvetica-Bold')
            .fontSize(10)
            .text(String(item.alto), colX.alto + 4, rowY + 10, { width: 64, align: 'center' })
        }

        // Celda ANCHO
        doc.roundedRect(colX.ancho + 4, rowY + 3, 64, 26, 4)
          .fillAndStroke('#FFFFFF', '#CBD5E1')
        if (item?.ancho) {
          doc.fillColor('#1E3A8A')
            .font('Helvetica-Bold')
            .fontSize(10)
            .text(String(item.ancho), colX.ancho + 4, rowY + 10, { width: 64, align: 'center' })
        }

        // Celda PROFUNDIDAD
        doc.roundedRect(colX.prof + 4, rowY + 3, 78, 26, 4)
          .fillAndStroke('#FFFFFF', '#CBD5E1')
        if (item?.profundidad) {
          doc.fillColor('#1E3A8A')
            .font('Helvetica-Bold')
            .fontSize(10)
            .text(String(item.profundidad), colX.prof + 4, rowY + 10, { width: 78, align: 'center' })
        }

        // Checkboxes SENTIDO DE APERTURA
        const apertX = colX.apert + 12
        const isIzq = item ? (item.apertura === 'IZQ' || !item.apertura) : false
        const isDer = item ? item.apertura === 'DER' : false

        // Check IZQ
        drawCheckSquare(apertX, rowY + 10, item ? isIzq : false)
        doc.fillColor('#000000')
          .font('Helvetica-Bold')
          .fontSize(8)
          .text('IZQ.', apertX + 16, rowY + 12)

        // Check DER
        drawCheckSquare(apertX + 62, rowY + 10, item ? isDer : false)
        doc.fillColor('#000000')
          .font('Helvetica-Bold')
          .fontSize(8)
          .text('DER.', apertX + 78, rowY + 12)
      }

      // ── 7. SECCIÓN OBSERVACIONES GENERALES ─────────────────────────────
      const obsY = startRowY + (8 * rowHeight) + 12
      doc.roundedRect(left, obsY, 210, 18, 3)
        .fill('#FEF7EE')

      doc.fillColor('#000000')
        .font('Helvetica-Bold')
        .fontSize(8)
        .text('OBSERVACIONES GENERALES (OPCIONAL)', left + 10, obsY + 5)

      const obsBoxY = obsY + 22
      doc.roundedRect(left, obsBoxY, contentWidth, 80, 6)
        .fillAndStroke('#FFFFFF', '#CBD5E1')

      if (data.observaciones) {
        doc.fillColor('#1E3A8A')
          .font('Helvetica')
          .fontSize(9.5)
          .text(data.observaciones, left + 12, obsBoxY + 10, { width: contentWidth - 24 })
      }

      // ── 8. PIE DE PÁGINA ──────────────────────────────────────────────
      const footerY = 788
      doc.strokeColor('#C29B62')
        .lineWidth(1)
        .moveTo(left, footerY)
        .lineTo(right, footerY)
        .stroke()

      doc.fillColor('#64748B')
        .font('Helvetica-Bold')
        .fontSize(8)
        .text('EQUIPAMIENTOS · CONTROL DE MEDIDAS', left, footerY + 8)

      doc.fillColor('#64748B')
        .font('Helvetica')
        .fontSize(8)
        .text('Página 1 de 1', right - 100, footerY + 8, { width: 100, align: 'right' })

      doc.end()
    } catch (err) {
      reject(err)
    }
  })
}
