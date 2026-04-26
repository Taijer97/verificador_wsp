const express = require('express')
const { Client, LocalAuth } = require('whatsapp-web.js')
const QRCode = require('qrcode')
const fs = require('fs')
const path = require('path')

const app = express()
const PORT = 3009

app.use(express.json())

// almacenamiento en memoria
const clients = {}
const readyUsers = {}
const qrCodes = {}
const lastRequest = {}

const SESSION_PATH = path.join(__dirname, '.wwebjs_auth')

function clearWhatsAppData() {
    const authPath = path.join(__dirname, '.wwebjs_auth')
    const cachePath = path.join(__dirname, '.wwebjs_cache')

    try {
        if (fs.existsSync(authPath)) {
            console.log('🧹 Eliminando .wwebjs_auth')
            fs.rmSync(authPath, { recursive: true, force: true })
        }

        if (fs.existsSync(cachePath)) {
            console.log('🧹 Eliminando .wwebjs_cache')
            fs.rmSync(cachePath, { recursive: true, force: true })
        }

    } catch (err) {
        console.log('❌ Error limpiando carpetas:', err.message)
    }
}

const RESET = true // cambia a false en producción

if (RESET) {
    clearWhatsAppData()
}

// 🔒 RATE LIMIT
function canRequest(dni) {
    const now = Date.now()

    if (!lastRequest[dni]) {
        lastRequest[dni] = now
        return true
    }

    if (now - lastRequest[dni] < 3000) {
        return false
    }

    lastRequest[dni] = now
    return true
}


// 🔄 RESTAURAR SESIONES AL INICIAR
async function loadSessions() {
    if (!fs.existsSync(SESSION_PATH)) return

    const folders = fs.readdirSync(SESSION_PATH, { withFileTypes: true })

    for (let folder of folders) {
        if (!folder.isDirectory()) continue
        if (!folder.name.startsWith('session-')) continue

        const dni = folder.name.replace('session-', '')

        console.log(`🔄 Restaurando sesión ${dni}`)

        createClient(dni, true)
    }
}


// 🔧 CREAR CLIENTE
function cleanLocks(dni) {
    const sessionPath = path.join(SESSION_PATH, `session-${dni}`)

    const lockPath = path.join(sessionPath, 'SingletonLock')

    if (fs.existsSync(lockPath)) {
        console.log(`🧹 Eliminando lock ${dni}`)
        try {
            fs.rmSync(lockPath)
        } catch {}
    }
}

function createClient(dni) {
    // 🔒 evitar duplicados
    if (clients[dni]) {
        console.log(`⚠️ Cliente ya existe ${dni}`)
        return
    }

    cleanLocks(dni)

    const client = new Client({
        authStrategy: new LocalAuth({ clientId: dni }),
        puppeteer: {
            headless: true, // puedes poner false si quieres debug
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage'
            ]
        }
    })

    clients[dni] = client
    readyUsers[dni] = false

    let connected = false

    // ⏳ timeout más inteligente
    const timeout = setTimeout(async () => {
        if (!connected) {
            console.log(`⏰ Timeout ${dni} (no conectado)`)

            try {
                await client.destroy()
            } catch {}

            delete clients[dni]
            delete readyUsers[dni]
            delete qrCodes[dni]

            // ⚠️ NO borrar sesión aquí automáticamente
        }
    }, 60000)

    client.on('qr', async (qr) => {
        console.log(`📱 QR generado ${dni}`)
        qrCodes[dni] = await QRCode.toDataURL(qr)
    })

    client.on('ready', () => {
        connected = true
        clearTimeout(timeout)

        console.log(`✅ ${dni} conectado`)
        readyUsers[dni] = true
        qrCodes[dni] = null
    })

    client.on('auth_failure', async () => {
        console.log(`❌ Auth failure ${dni}`)

        readyUsers[dni] = false
        qrCodes[dni] = null

        // 🔥 aquí sí limpiar sesión
        const sessionPath = path.join(SESSION_PATH, `session-${dni}`)
        fs.rmSync(sessionPath, { recursive: true, force: true })

        try {
            await client.destroy()
        } catch {}

        delete clients[dni]
    })

    client.on('disconnected', () => {
        console.log(`❌ ${dni} desconectado`)
        readyUsers[dni] = false
    })

    client.initialize()
}


// 📱 AUTH (crear o consultar sesión)
app.get('/auth', async (req, res) => {
    const { dni } = req.query

    if (!dni) {
        return res.json({ error: 'Falta DNI' })
    }

    const client = clients[dni]

    // 🟢 YA EXISTE
    if (client) {
        // ✔ ya conectado
        if (readyUsers[dni]) {
            return res.json({ status: 'conectado' })
        }

        // ⏳ aún conectando (NO reiniciar)
        if (!qrCodes[dni]) {
            return res.json({
                status: 'conectando',
                mensaje: 'Esperando conexión...'
            })
        }

        // 📱 tiene QR
        return res.json({
            status: 'pendiente',
            qr: qrCodes[dni]
        })
    }

    // 🔵 NO EXISTE → crear nuevo
    createClient(dni)

    return res.json({
        status: 'creando',
        mensaje: 'Generando QR...'
    })
})

// 🔍 VERIFICAR UNO
app.get('/verificar', async (req, res) => {
    const { dni, numero } = req.query

    if (!dni || !numero) {
        return res.json({ error: 'Faltan parámetros' })
    }

    if (!/^\d{10,15}$/.test(numero)) {
        return res.json({ error: 'Número inválido' })
    }

    if (!canRequest(dni)) {
        return res.json({ error: 'Espera unos segundos' })
    }

    const client = clients[dni]

    if (!client) {
        return res.json({ error: 'Usuario no registrado' })
    }

    if (!readyUsers[dni]) {
        return res.json({
            error: 'No conectado',
            qr: qrCodes[dni] || null
        })
    }

    try {
        const result = await client.isRegisteredUser(numero)

        res.json({
            dni,
            numero,
            tiene_whatsapp: result
        })

    } catch (err) {
        res.json({ error: err.message })
    }
})


// 🔥 VERIFICACIÓN MASIVA
app.post('/verificar-masivo', async (req, res) => {
    const { dni, numeros } = req.body

    if (!dni || !Array.isArray(numeros)) {
        return res.json({ error: 'Datos inválidos' })
    }

    const client = clients[dni]

    if (!client || !readyUsers[dni]) {
        return res.json({
            error: 'Usuario no conectado',
            qr: qrCodes[dni] || null
        })
    }

    const resultados = []

    for (let numero of numeros) {
        if (!/^\d{10,15}$/.test(numero)) {
            resultados.push({ numero, error: 'inválido' })
            continue
        }

        try {
            const result = await client.isRegisteredUser(numero)

            resultados.push({
                numero,
                tiene_whatsapp: result
            })

            const delay = Math.floor(Math.random() * 3000) + 2000
            await new Promise(r => setTimeout(r, delay))

        } catch (err) {
            resultados.push({ numero, error: err.message })
        }
    }

    res.json({
        total: numeros.length,
        resultados
    })
})

process.on('SIGINT', async () => {
    console.log('🔻 Cerrando sistema...')

    for (let dni in clients) {
        try {
            await clients[dni].destroy()
        } catch {}
    }

    process.exit()
})

// 🚀 START
async function startServer() {
    await loadSessions()
    console.log('📦 Clientes cargados:', Object.keys(clients))
    app.listen(PORT, () => {
        console.log(`🚀 API corriendo en http://localhost:${PORT}`)
    })
}

startServer()