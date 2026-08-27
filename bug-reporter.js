const fs = require('fs');
const path = require('path');

class BugReporter {
  constructor() {
    this.bugsDir = path.join(__dirname, 'bug-reports');
    this.currentSessionFile = null;
    this.bugCount = 0;
    
    // Cria diretório de bugs se não existir
    if (!fs.existsSync(this.bugsDir)) {
      fs.mkdirSync(this.bugsDir, { recursive: true });
    }
    
    // Inicia nova sessão
    this.startNewSession();
    
    // Captura erros não tratados
    this.setupGlobalErrorHandlers();
  }
  
  startNewSession() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const sessionId = `session_${timestamp}`;
    this.currentSessionFile = path.join(this.bugsDir, `${sessionId}.txt`);
    
    const header = `
╔═══════════════════════════════════════════════════════════════╗
║           RELATÓRIO DE BUGS - CHAMADAAPP                      ║
║                  Sessão: ${new Date().toLocaleString('pt-BR')}                   ║
╚═══════════════════════════════════════════════════════════════╝

Sistema: ${process.platform}
Node.js: ${process.version}
Diretório: ${process.cwd()}
PID: ${process.pid}

═══════════════════════════════════════════════════════════════

`;
    
    fs.writeFileSync(this.currentSessionFile, header);
    console.log(`📋 Sistema de relatório de bugs iniciado: ${this.currentSessionFile}`);
  }
  
  reportBug(type, error, context = {}) {
    this.bugCount++;
    
    const bugReport = `
┌─────────────────────────────────────────────────────────────┐
│ BUG #${this.bugCount} - ${type.toUpperCase()}
│ Timestamp: ${new Date().toISOString()}
│ Horário: ${new Date().toLocaleString('pt-BR')}
└─────────────────────────────────────────────────────────────┘

━━━ ERRO ━━━
${error.message || error}

━━━ STACK TRACE ━━━
${error.stack || 'N/A'}

━━━ CONTEXTO ━━━
${JSON.stringify(context, null, 2)}

━━━ MEMÓRIA ━━━
RSS: ${(process.memoryUsage().rss / 1024 / 1024).toFixed(2)} MB
Heap Total: ${(process.memoryUsage().heapTotal / 1024 / 1024).toFixed(2)} MB
Heap Used: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

`;
    
    fs.appendFileSync(this.currentSessionFile, bugReport);
    console.error(`🐛 Bug #${this.bugCount} reportado: ${type} - ${error.message}`);
    
    return this.bugCount;
  }
  
  reportInfo(message, data = {}) {
    const infoReport = `
ℹ️  INFO - ${new Date().toLocaleTimeString('pt-BR')}
${message}
${Object.keys(data).length > 0 ? JSON.stringify(data, null, 2) : ''}

`;
    
    fs.appendFileSync(this.currentSessionFile, infoReport);
  }
  
  reportWarning(message, data = {}) {
    const warningReport = `
⚠️  AVISO - ${new Date().toLocaleTimeString('pt-BR')}
${message}
${Object.keys(data).length > 0 ? JSON.stringify(data, null, 2) : ''}

`;
    
    fs.appendFileSync(this.currentSessionFile, warningReport);
  }
  
  setupGlobalErrorHandlers() {
    // Captura erros não tratados
    process.on('uncaughtException', (error) => {
      this.reportBug('UNCAUGHT_EXCEPTION', error, {
        tipo: 'Erro não capturado',
        critico: true
      });
      
      console.error('❌ ERRO CRÍTICO NÃO TRATADO:', error);
      console.log('📋 Bug reportado automaticamente!');
    });
    
    // Captura promises rejeitadas
    process.on('unhandledRejection', (reason, promise) => {
      this.reportBug('UNHANDLED_REJECTION', 
        reason instanceof Error ? reason : new Error(String(reason)), 
        {
          tipo: 'Promise rejeitada não tratada',
          promise: String(promise)
        }
      );
      
      console.error('❌ PROMISE REJEITADA NÃO TRATADA:', reason);
      console.log('📋 Bug reportado automaticamente!');
    });
    
    // Captura avisos
    process.on('warning', (warning) => {
      this.reportWarning(`Node.js Warning: ${warning.name}`, {
        message: warning.message,
        stack: warning.stack
      });
    });
  }
  
  getSummary() {
    const summary = `
╔═══════════════════════════════════════════════════════════════╗
║                      RESUMO DA SESSÃO                          ║
╚═══════════════════════════════════════════════════════════════╝

Total de bugs reportados: ${this.bugCount}
Arquivo de relatório: ${this.currentSessionFile}
Duração da sessão: ${process.uptime().toFixed(2)} segundos

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

`;
    
    fs.appendFileSync(this.currentSessionFile, summary);
    return summary;
  }
  
  // Lista todos os relatórios
  static listReports() {
    const bugsDir = path.join(__dirname, 'bug-reports');
    
    if (!fs.existsSync(bugsDir)) {
      return [];
    }
    
    return fs.readdirSync(bugsDir)
      .filter(file => file.endsWith('.txt'))
      .map(file => {
        const filePath = path.join(bugsDir, file);
        const stats = fs.statSync(filePath);
        return {
          filename: file,
          path: filePath,
          size: stats.size,
          created: stats.birthtime,
          modified: stats.mtime
        };
      })
      .sort((a, b) => b.created - a.created);
  }
  
  // Obtém o último relatório
  static getLatestReport() {
    const reports = BugReporter.listReports();
    if (reports.length === 0) return null;
    
    const latest = reports[0];
    return {
      ...latest,
      content: fs.readFileSync(latest.path, 'utf-8')
    };
  }
}

module.exports = BugReporter;
