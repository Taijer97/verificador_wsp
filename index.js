const express = require('express')
const { Client, LocalAuth } = require('whatsapp-web.js')
const QRCode = require('qrcode')
const fs = require('fs')
const path = require('path')
const axios = require('axios')
const dotenv = require('dotenv').config()

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
        const emptyDir = (dirPath) => {
            if (!fs.existsSync(dirPath)) return
            const entries = fs.readdirSync(dirPath, { withFileTypes: true })
            for (const entry of entries) {
                const p = path.join(dirPath, entry.name)
                try {
                    fs.rmSync(p, { recursive: true, force: true })
                } catch {}
            }
        }

        if (fs.existsSync(authPath)) {
            console.log('🧹 Limpiando .wwebjs_auth')
            emptyDir(authPath)
        }

        if (fs.existsSync(cachePath)) {
            console.log('🧹 Limpiando .wwebjs_cache')
            emptyDir(cachePath)
        }

    } catch (err) {
        console.log('❌ Error limpiando carpetas:', err.message)
    }
}

const RESET = (process.env.RESET_WWEBJS ?? 'false').toLowerCase() === 'true'

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

    if (!fs.existsSync(sessionPath)) return

    const lockFiles = [
        'SingletonLock',
        'SingletonCookie',
        'SingletonSocket',
        'DevToolsActivePort'
    ]

    let removedAny = false

    for (const name of lockFiles) {
        const p = path.join(sessionPath, name)
        if (!fs.existsSync(p)) continue
        try {
            fs.rmSync(p, { force: true })
            removedAny = true
        } catch {}
    }

    try {
        const extra = fs.readdirSync(sessionPath)
        for (const name of extra) {
            if (!name.startsWith('Singleton')) continue
            try {
                fs.rmSync(path.join(sessionPath, name), { force: true })
                removedAny = true
            } catch {}
        }
    } catch {}

    if (removedAny) {
        console.log(`🧹 Locks limpiados ${dni}`)
    }
}

function createClient(dni) {
    // 🔒 evitar duplicados
    if (clients[dni]) {
        console.log(`⚠️ Cliente ya existe ${dni}`)
        return
    }

    cleanLocks(dni)

    const executablePath =
        process.env.PUPPETEER_EXECUTABLE_PATH ||
        process.env.CHROME_BIN ||
        '/usr/bin/chromium'

    const client = new Client({
        authStrategy: new LocalAuth({ clientId: dni, dataPath: SESSION_PATH }),
        puppeteer: {
            headless: 'new',
            executablePath,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-zygote'
            ]
        }
    })

    clients[dni] = client
    readyUsers[dni] = false

    let connected = false

    const initTimeoutMs = Number.parseInt(process.env.INIT_TIMEOUT_MS ?? '600000', 10)
    const timeoutMs = Number.isFinite(initTimeoutMs) && initTimeoutMs > 0 ? initTimeoutMs : 600000
    const destroyOnTimeout = (process.env.DESTROY_ON_TIMEOUT ?? 'false').toLowerCase() === 'true'

    const timeout = setTimeout(async () => {
        if (!connected) {
            console.log(`⏰ Timeout ${dni} (no conectado)`)

            if (destroyOnTimeout) {
                try {
                    await client.destroy()
                } catch {}

                delete clients[dni]
                delete readyUsers[dni]
                delete qrCodes[dni]
            }

            // ⚠️ NO borrar sesión aquí automáticamente
        }
    }, timeoutMs)

    client.on('qr', async (qr) => {
        console.log(`📱 QR generado ${dni}`)
        qrCodes[dni] = await QRCode.toDataURL(qr)
    })

    client.on('authenticated', () => {
        connected = true
        clearTimeout(timeout)
        console.log(`🔐 ${dni} autenticado`)
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

    client.initialize().catch(async (err) => {
        console.log(`❌ Error inicializando ${dni}:`, err?.message || err)
        readyUsers[dni] = false
        qrCodes[dni] = null
        try {
            await client.destroy()
        } catch {}
        delete clients[dni]
        delete readyUsers[dni]
        delete qrCodes[dni]
    })
}

const URL_OSIPTEL = process.env.URL_OSIPTEL
const TOKEN_OSIPTEL = process.env.TOKEN_OSIPTEL

async function getCelPhone(dni) {
    try {
        const response = await axios.get(`${URL_OSIPTEL}${dni}?token=${TOKEN_OSIPTEL}`)

        if (response.status !== 200) {
            throw new Error("API osiptel no devolvió datos")
        }

        const data = response.data

        if (!data.datos) return data

        // 🔹 procesar teléfonos
        data.datos = data.datos.map(item => {
            let telefono = item.telefono

            if (
                telefono &&
                /^\d+$/.test(telefono) &&
                telefono.length === 9
            ) {
                telefono = "51" + telefono
            }

            return {
                ...item,
                telefono
            }
        })

        return data

    } catch (err) {
        throw new Error("Error obteniendo datos OSIPTEL")
    }
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

async function verificarMasivoInterno(client, numeros) {
    const resultados = []

    for (let numero of numeros) {
        try {
            const result = await client.isRegisteredUser(numero)

            resultados.push({
                numero,
                tiene_whatsapp: result
            })

            // 🔥 delay reducido
            await new Promise(r => setTimeout(r, 1000))

        } catch (err) {
            resultados.push({ numero, error: err.message })
        }
    }

    return resultados
}

app.get('/verificar-dni', async (req, res) => {
    const { dni_verify, dni } = req.query

    if (!dni || !dni_verify) {
        return res.json({ error: 'Faltan parámetros' })
    }

    let data

    try {
        data = await getCelPhone(dni)
    } catch (err) {
        return res.json({ error: 'Error obteniendo datos' })
    }

    if (!data.datos) {
        return res.json({ error: 'DNI sin resultados' })
    }

    const numeros = []
    const procesados = new Set()

    // 🔹 preparar números
    for (let item of data.datos) {
        let estado = (item.estado || '').toLowerCase()
        let numero = String(item.telefono || '').replace(/\D/g, '')

        // 🔹 normalizar Perú
        if (numero.length === 9) {
            numero = "51" + numero
        }

        // 🔹 evitar doble 51
        if (numero.startsWith("51") && numero.length === 11) {
            // OK
        } else {
            continue
        }

        if (!estado.includes('activo') && !estado.includes('active')) continue
    
        if (procesados.has(numero)) continue

        procesados.add(numero)
        numeros.push(numero)
    }

    if (numeros.length === 0) {
        return res.json({
            dni,
            total: 0,
            resultados: []
        })
    }

    // 🔥 llamada a tu API de WhatsApp
    let resp

    const client = clients[dni_verify]

    if (!client || !readyUsers[dni_verify]) {
        return res.json({
            error: 'Usuario no conectado',
            qr: qrCodes[dni_verify] || null
        })
    }
    
    let resultadosRaw

    try {
        resultadosRaw = await verificarMasivoInterno(client, numeros)
    } catch (err) {
        return res.json({ error: 'Error procesando números' })
    }

    const resultados = resultadosRaw.map(item => ({
        numero: item.numero,
        whatsapp: item.tiene_whatsapp ? "SI" : "NO"
    }))

    return res.json({
        dni,
        total: resultados.length,
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

process.on('unhandledRejection', (reason) => {
    console.log('❌ UnhandledRejection:', reason?.message || reason)
})

process.on('uncaughtException', (err) => {
    console.log('❌ UncaughtException:', err?.message || err)
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
