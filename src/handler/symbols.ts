import { Neovim } from '@chemzqm/neovim'
import debounce from 'debounce'
import { CancellationTokenSource, Disposable, DocumentSymbol, Emitter, Event, Range, SymbolInformation, TextDocument } from 'vscode-languageserver-protocol'
import events from '../events'
import languages from '../languages'
import BufferSync, { SyncItem } from '../model/bufferSync'
import { HandlerDelegate } from '../types'
import { getSymbolKind } from '../util/convert'
import { disposeAll } from '../util/index'
import { equals } from '../util/object'
import { positionInRange, rangeInRange } from '../util/position'
import window from '../window'
import workspace from '../workspace'
import { addDocumentSymbol, isDocumentSymbols, sortDocumentSymbols, sortSymbolInformations, SymbolInfo } from './helper'

export default class Symbols {
  private buffers: BufferSync<SymbolsBuffer>
  private disposables: Disposable[] = []

  constructor(
    private nvim: Neovim,
    private handler: HandlerDelegate
  ) {
    this.buffers = workspace.registerBufferSync(doc => {
      if (doc.buftype != '') return undefined
      let buf = new SymbolsBuffer(doc.bufnr)
      buf.onDidUpdate(async symbols => {
        await events.fire('SymbolsUpdate', [buf.bufnr, symbols])
      })
      return buf
    })
    events.on('CursorHold', async (bufnr: number) => {
      if (!this.functionUpdate || this.buffers.getItem(bufnr) == null) return
      await this.getCurrentFunctionSymbol(bufnr)
    }, null, this.disposables)
    events.on('InsertEnter', (bufnr: number) => {
      let buf = this.buffers.getItem(bufnr)
      if (buf) buf.cancel()
    }, null, this.disposables)
  }

  public get functionUpdate(): boolean {
    let config = workspace.getConfiguration('coc.preferences')
    return config.get<boolean>('currentFunctionSymbolAutoUpdate', false)
  }

  public get labels(): { [key: string]: string } {
    return workspace.getConfiguration('suggest').get<any>('completionItemKindLabels', {})
  }

  public async getWorkspaceSymbols(input: string): Promise<SymbolInformation[]> {
    this.handler.checkProvier('workspaceSymbols', null)
    let tokenSource = new CancellationTokenSource()
    return await languages.getWorkspaceSymbols(input, tokenSource.token)
  }

  public async resolveWorkspaceSymbol(symbolInfo: SymbolInformation): Promise<SymbolInformation> {
    if (symbolInfo.location?.uri) return symbolInfo
    let tokenSource = new CancellationTokenSource()
    return await languages.resolveWorkspaceSymbol(symbolInfo, tokenSource.token)
  }

  public async getDocumentSymbols(bufnr: number): Promise<SymbolInfo[]> {
    let buf = this.buffers.getItem(bufnr)
    return buf?.getSymbols()
  }

  public async getCurrentFunctionInfo(bufnr?: number): Promise< any[]> {
    if (!bufnr) bufnr = await this.nvim.call('bufnr', ['%'])
    let doc = workspace.getDocument(bufnr)
    if (!doc || !doc.attached) return []
    if (!languages.hasProvider('documentSymbol', doc.textDocument)) return []
    let position = await window.getCursorPosition()
    let symbols = await this.getDocumentSymbols(bufnr)
    if (!symbols || symbols.length === 0) {
      return []
    }
    let info = []
    for (let sym of symbols.reverse()) {
      if (sym.range
        && positionInRange(position, sym.range) == 0
        && !sym.text.endsWith(') callback')) {
		  let functionName = sym.text
		  let functionStart = sym.range.start
		  let functionEnd = sym.range.end
		  info = [functionName, functionStart, functionEnd]
        break
      }
    }
    return info
  }

  public async getCurrentFunctionSymbol(bufnr?: number): Promise<string> {
    if (!bufnr) bufnr = await this.nvim.call('bufnr', ['%'])
    let doc = workspace.getDocument(bufnr)
    if (!doc || !doc.attached) return
    if (!languages.hasProvider('documentSymbol', doc.textDocument)) return
    let position = await window.getCursorPosition()
    let symbols = await this.getDocumentSymbols(bufnr)
    let buffer = this.nvim.createBuffer(bufnr)
    if (!symbols || symbols.length === 0) {
      buffer.setVar('coc_current_function', '', true)
      this.nvim.call('coc#util#do_autocmd', ['CocStatusChange'], true)
      return ''
    }
    symbols = symbols.filter(s => [
      'Class',
      'Method',
      'Function',
      'Struct',
    ].includes(s.kind))
    let functionName = ''
    for (let sym of symbols.reverse()) {
      if (sym.range
        && positionInRange(position, sym.range) == 0
        && !sym.text.endsWith(') callback')) {
        functionName = sym.text
        let label = this.labels[sym.kind.toLowerCase()]
        if (label) functionName = `${label} ${functionName}`
        break
      }
    }
    if (this.functionUpdate) {
      buffer.setVar('coc_current_function', functionName, true)
      this.nvim.call('coc#util#do_autocmd', ['CocStatusChange'], true)
    }
    return functionName
  }

  /*
   * supportedSymbols must be string values of symbolKind
   */
  public async selectSymbolRange(inner: boolean, visualmode: string, supportedSymbols: string[]): Promise<void> {
    let { doc } = await this.handler.getCurrentState()
    this.handler.checkProvier('documentSymbol', doc.textDocument)
    let range: Range
    if (visualmode) {
      range = await workspace.getSelectedRange(visualmode, doc)
    } else {
      let pos = await window.getCursorPosition()
      range = Range.create(pos, pos)
    }
    let symbols = await this.getDocumentSymbols(doc.bufnr)
    if (!symbols || symbols.length === 0) {
      window.showMessage('No symbols found', 'warning')
      return
    }
    symbols = symbols.filter(s => supportedSymbols.includes(s.kind))
    let selectRange: Range
    for (let sym of symbols.reverse()) {
      if (sym.range && !equals(sym.range, range) && rangeInRange(range, sym.range)) {
        selectRange = sym.range
        break
      }
    }
    if (inner && selectRange) {
      let { start, end } = selectRange
      let line = doc.getline(start.line + 1)
      let endLine = doc.getline(end.line - 1)
      selectRange = Range.create(start.line + 1, line.match(/^\s*/)[0].length, end.line - 1, endLine.length)
    }
    if (selectRange) {
      await workspace.selectRange(selectRange)
    } else if (['v', 'V', '\x16'].includes(visualmode)) {
      await this.nvim.command('normal! gv')
    }
  }

  public dispose(): void {
    this.buffers.dispose()
    disposeAll(this.disposables)
  }
}

class SymbolsBuffer implements SyncItem {
  private disposables: Disposable[] = []
  public fetchSymbols: (() => void) & { clear(): void }
  private version: number
  public autoUpdate = false
  private symbols: SymbolInfo[] = []
  private tokenSource: CancellationTokenSource
  private readonly _onDidUpdate = new Emitter<DocumentSymbol[]>()
  public readonly onDidUpdate: Event<DocumentSymbol[]> = this._onDidUpdate.event
  constructor(public readonly bufnr: number) {
    this.fetchSymbols = debounce(() => {
      this._fetchSymbols().logError()
    }, global.hasOwnProperty('__TEST__') ? 10 : 500)
  }

  public async getSymbols(): Promise<SymbolInfo[]> {
    let doc = workspace.getDocument(this.bufnr)
    if (!doc) return []
    doc.forceSync()
    this.autoUpdate = true
    if (doc.version == this.version) return this.symbols
    this.cancel()
    await this._fetchSymbols()
    return this.symbols
  }

  public onChange(): void {
    this.cancel()
  }

  private get textDocument(): TextDocument | undefined {
    return workspace.getDocument(this.bufnr)?.textDocument
  }

  private async _fetchSymbols(): Promise<void> {
    let { textDocument } = this
    if (!textDocument || textDocument.version == this.version) return
    let { version } = textDocument
    let tokenSource = this.tokenSource = new CancellationTokenSource()
    let { token } = tokenSource
    let symbols = await languages.getDocumentSymbol(textDocument, token)
    this.tokenSource = undefined
    if (symbols == null || token.isCancellationRequested) return
    let level = 0
    let res: SymbolInfo[] = []
    if (isDocumentSymbols(symbols)) {
      symbols.sort(sortDocumentSymbols)
      symbols.forEach(s => addDocumentSymbol(res, s, level))
    } else {
      symbols.sort(sortSymbolInformations)
      for (let sym of symbols) {
        let { name, kind, location } = sym
        let { start } = location.range
        let o: SymbolInfo = {
          col: start.character + 1,
          lnum: start.line + 1,
          text: name,
          level: 0,
          kind: getSymbolKind(kind),
          range: location.range,
          containerName: sym.containerName
        }
        res.push(o)
      }
    }
    this.version = version
    this.symbols = res
    if (isDocumentSymbols(symbols)) {
      this._onDidUpdate.fire(symbols)
    } else {
      this._onDidUpdate.fire(symbols.map(o => {
        return DocumentSymbol.create(o.name, '', o.kind, o.location.range, o.location.range)
      }))
    }
  }

  public cancel(): void {
    this.fetchSymbols.clear()
    if (this.tokenSource) {
      this.tokenSource.cancel()
      this.tokenSource = null
    }
  }

  public dispose(): void {
    this.cancel()
    this.symbols = undefined
    this._onDidUpdate.dispose()
    disposeAll(this.disposables)
  }
}
