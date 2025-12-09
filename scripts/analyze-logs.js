#!/usr/bin/env node
/**
 * Script de análisis de logs para encontrar patrones de mensajes perdidos
 *
 * Uso: node scripts/analyze-logs.js [archivo-log]
 *
 * Si no se especifica archivo, usa combined.log
 */

const fs = require('fs');
const path = require('path');

// Leer archivo de logs
const logFile = process.argv[2] || path.join(__dirname, '../combined.log');

if (!fs.existsSync(logFile)) {
  console.error(`❌ Archivo no encontrado: ${logFile}`);
  process.exit(1);
}

console.log(`📊 Analizando logs: ${logFile}\n`);

const logContent = fs.readFileSync(logFile, 'utf-8');
const lines = logContent.split('\n').filter(line => line.trim());

// Parsear logs JSON
const logs = [];
for (const line of lines) {
  try {
    const log = JSON.parse(line);
    logs.push(log);
  } catch (e) {
    // Ignorar líneas que no son JSON
  }
}

console.log(`✅ Total logs parseados: ${logs.length}\n`);

// Filtrar solo logs de webhook WhatsApp
const webhookReceived = logs.filter(log => log.message === '📥 Webhook received');
const webhookSuccess = logs.filter(log => log.message === '✅ Webhook processed successfully');
const webhookErrors = logs.filter(log => log.message === '❌ WhatsApp webhook error');
const invalidPayloads = logs.filter(log => log.message === '❌ Invalid WhatsApp payload - mensaje descartado');
const unsupportedTypes = logs.filter(log => log.message === '❌ Unsupported message type - mensaje descartado');
const groupMessages = logs.filter(log => log.message && log.message.includes('Mensaje de grupo') || log.message.includes('Mensaje de lista'));

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('📈 RESUMEN GENERAL');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`📥 Webhooks recibidos:        ${webhookReceived.length}`);
console.log(`✅ Procesados con éxito:      ${webhookSuccess.length}`);
console.log(`❌ Errores:                   ${webhookErrors.length}`);
console.log(`⚠️  Payloads inválidos:       ${invalidPayloads.length}`);
console.log(`⚠️  Tipos no soportados:      ${unsupportedTypes.length}`);
console.log(`⏭️  Mensajes de grupo/lista:  ${groupMessages.length}`);

// Filtrar solo mensajes entrantes (fromMe: false)
const incomingReceived = webhookReceived.filter(log => log.fromMe === false);
const incomingSuccess = webhookSuccess.filter(log => log.direction === 'inbound');

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('📨 MENSAJES ENTRANTES (fromMe: false)');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`📥 Recibidos:       ${incomingReceived.length}`);
console.log(`✅ Exitosos:        ${incomingSuccess.length}`);
console.log(`❌ Perdidos/Error:  ${incomingReceived.length - incomingSuccess.length}`);

if (incomingReceived.length > 0) {
  const successRate = ((incomingSuccess.length / incomingReceived.length) * 100).toFixed(2);
  console.log(`📊 Tasa de éxito:   ${successRate}%`);
}

// Crear mapa de mensajes recibidos por messageId
const receivedMap = new Map();
webhookReceived.forEach(log => {
  if (log.messageId && log.fromMe === false) {
    receivedMap.set(log.messageId, log);
  }
});

// Crear mapa de mensajes exitosos por messageId
const successMap = new Map();
webhookSuccess.forEach(log => {
  if (log.messageId) {
    successMap.set(log.messageId, log);
  }
});

// Encontrar mensajes perdidos (recibidos pero no procesados)
const lostMessages = [];
receivedMap.forEach((log, messageId) => {
  if (!successMap.has(messageId)) {
    lostMessages.push(log);
  }
});

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🔍 MENSAJES PERDIDOS (recibidos pero no procesados)');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`Total: ${lostMessages.length}\n`);

if (lostMessages.length > 0) {
  // Agrupar por instancia
  const byInstance = {};
  lostMessages.forEach(log => {
    const instance = log.instanceName || 'unknown';
    if (!byInstance[instance]) {
      byInstance[instance] = [];
    }
    byInstance[instance].push(log);
  });

  console.log('Por instancia:');
  Object.keys(byInstance).sort().forEach(instance => {
    console.log(`  📍 ${instance}: ${byInstance[instance].length} mensajes`);
  });

  console.log('\nÚltimos 10 mensajes perdidos:');
  lostMessages.slice(-10).forEach((log, idx) => {
    console.log(`\n${idx + 1}. MessageID: ${log.messageId}`);
    console.log(`   Instancia: ${log.instanceName}`);
    console.log(`   De: ${log.remoteJid}`);
    console.log(`   Timestamp: ${log.timestamp}`);
  });
}

// Análisis por instancia
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('📊 ANÁLISIS POR INSTANCIA');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

const instanceStats = {};

// Contar recibidos por instancia
incomingReceived.forEach(log => {
  const instance = log.instanceName || 'unknown';
  if (!instanceStats[instance]) {
    instanceStats[instance] = { received: 0, success: 0, errors: 0 };
  }
  instanceStats[instance].received++;
});

// Contar exitosos por instancia
incomingSuccess.forEach(log => {
  const instance = log.instanceName || 'unknown';
  if (!instanceStats[instance]) {
    instanceStats[instance] = { received: 0, success: 0, errors: 0 };
  }
  instanceStats[instance].success++;
});

// Contar errores por instancia
webhookErrors.forEach(log => {
  const instance = log.instance || 'unknown';
  if (instanceStats[instance]) {
    instanceStats[instance].errors++;
  }
});

// Mostrar tabla
console.log('Instancia'.padEnd(30) + ' | Recibidos | Exitosos | Errores | Perdidos | Tasa Éxito');
console.log('─'.repeat(95));

Object.keys(instanceStats).sort().forEach(instance => {
  const stats = instanceStats[instance];
  const lost = stats.received - stats.success;
  const successRate = stats.received > 0 ? ((stats.success / stats.received) * 100).toFixed(1) : '0.0';

  console.log(
    instance.padEnd(30) + ' | ' +
    String(stats.received).padStart(9) + ' | ' +
    String(stats.success).padStart(8) + ' | ' +
    String(stats.errors).padStart(7) + ' | ' +
    String(lost).padStart(8) + ' | ' +
    (successRate + '%').padStart(11)
  );
});

// Análisis de timing (si hay datos)
const successWithTiming = webhookSuccess.filter(log => log.processingTimeMs);
if (successWithTiming.length > 0) {
  const times = successWithTiming.map(log => log.processingTimeMs).sort((a, b) => a - b);
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const min = times[0];
  const max = times[times.length - 1];
  const median = times[Math.floor(times.length / 2)];
  const p95 = times[Math.floor(times.length * 0.95)];

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('⏱️  ANÁLISIS DE TIMING (procesamiento exitoso)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Promedio: ${avg.toFixed(0)}ms`);
  console.log(`Mínimo:   ${min}ms`);
  console.log(`Mediana:  ${median}ms`);
  console.log(`P95:      ${p95}ms`);
  console.log(`Máximo:   ${max}ms`);
}

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🎯 RECOMENDACIONES');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

if (lostMessages.length > 0) {
  console.log('⚠️  Hay mensajes que llegan al webhook pero no se procesan.');
  console.log('   Revisa los logs para ver en qué paso fallan:');
  console.log('   - grep "❌" combined.log | grep -v "test_" | tail -20\n');
}

if (invalidPayloads.length > 0) {
  console.log('⚠️  Hay payloads inválidos siendo rechazados.');
  console.log(`   Total: ${invalidPayloads.length}`);
  console.log('   Verifica la configuración de webhooks en Evolution API.\n');
}

if (unsupportedTypes.length > 0) {
  console.log('⚠️  Hay tipos de mensaje no soportados.');
  console.log(`   Total: ${unsupportedTypes.length}`);
  console.log('   Revisa qué tipos necesitan implementarse.\n');
}

const problematicInstances = Object.keys(instanceStats).filter(instance => {
  const stats = instanceStats[instance];
  const successRate = stats.received > 0 ? (stats.success / stats.received) * 100 : 100;
  return successRate < 90 && stats.received > 5; // Menos de 90% de éxito con al menos 5 mensajes
});

if (problematicInstances.length > 0) {
  console.log('⚠️  Instancias con problemas (< 90% éxito):');
  problematicInstances.forEach(instance => {
    const stats = instanceStats[instance];
    const successRate = ((stats.success / stats.received) * 100).toFixed(1);
    console.log(`   - ${instance}: ${successRate}% (${stats.success}/${stats.received})`);
  });
  console.log('   Revisa la configuración de estas instancias específicas.\n');
}

console.log('💡 Para más detalles, revisa combined.log con:');
console.log('   tail -f combined.log | grep -v "test_"');
console.log('\n');
