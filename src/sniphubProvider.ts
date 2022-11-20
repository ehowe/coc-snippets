import { Document, OutputChannel, Position, Range, window, workspace } from 'coc.nvim'
import http from 'http'

import type { Snippet, SnippetEdit, SniphubConfig } from './types'
import { TriggerKind } from './types'

import BaseProvider from './baseProvider'

interface SnippetContent {
  content: string
  created_at: string
  id: string
  language: string
  name: string
  public: boolean
  updated_at: string
}

interface HttpConfig {
  headers?: Record<string, string | number>
  host: string
  port: string
  protocol: string
  path?: string
  method: 'GET' | 'POST'
  url: URL
}

interface HttpError {
  code: string
}

interface HttpResponseItem {
  snippets: SnippetContent[]
}

type OnEnd = (resolve: (...args: any) => void, reject: (...args: any) => void, body: any) => void

function getMatched(snippet: Snippet, line: string): string | undefined {
  let { prefix, regex } = snippet
  if (regex) {
    let ms = line.match(regex)
    if (!ms) return undefined
    return ms[0]
  }
  if (!line.endsWith(prefix)) return undefined
  return prefix
}

const unknownFileTypes = ['typescriptreact', 'javascriptreact']

export class SniphubProvider extends BaseProvider {
  private sniphubItems: SnippetContent[]
  private baseHttpConfig: HttpConfig

  constructor(channel: OutputChannel, protected config: SniphubConfig) {
    super(config, channel)
  }

  public async init(): Promise<void> {
    const url = new URL(this.config.apiUrl)
    const { host, port, protocol } = url
    this.baseHttpConfig = { host, port, protocol, method: 'GET', url }
    const snippetResponse = await this.loadAllSnippets()
    this.sniphubItems = snippetResponse.snippets
  }

  public async getSnippetFiles(filetype: string): Promise<string[]> {
    let filetypes = this.getFiletypes(filetype)
    filetypes.push('all')
    let res: string[] = []
    for (let snippet of this.sniphubItems) {
      if (filetypes.includes(snippet.language)) {
        res.push(snippet.id)
      }
    }
    return res
  }

  public async getTriggerSnippets(document: Document, position: Position, autoTrigger?: boolean): Promise<SnippetEdit[]> {
    if (autoTrigger) return []

    const line = document.getline(position.line)
    if (line.length == 0) return []
    const snippets = this.getSnippets(document.filetype).filter(s => {
      if (autoTrigger && !s.autoTrigger) return false
      let match = getMatched(s, line)
      if (match == null) return false
      if (s.triggerKind == TriggerKind.InWord) return true
      let pre = line.slice(0, line.length - match.length)
      if (s.triggerKind == TriggerKind.LineBegin) return pre.trim() == ''
      if (s.triggerKind == TriggerKind.SpaceBefore) return pre.length == 0 || /\s$/.test(pre)
      if (s.triggerKind == TriggerKind.WordBoundary) return pre.length == 0 || !document.isWord(pre[pre.length - 1])
      return false
    })
    snippets.sort((a, b) => {
      if (a.context && !b.context) return -1
      if (b.context && !a.context) return 1
      return 0
    })
    let edits: SnippetEdit[] = []
    let hasContext = false
    for (let s of snippets) {
      let character: number
      if (s.context) {
        let valid = await this.checkContext(s.context)
        if (!valid) continue
        hasContext = true
      } else if (hasContext) {
        break
      }
      if (s.regex == null) {
        character = position.character - s.prefix.length
      } else {
        let len = line.match(s.regex)[0].length
        character = position.character - len
      }
      let range = Range.create(position.line, character, position.line, position.character)
      edits.push({
        range,
        newText: s.body,
        prefix: s.prefix,
        description: s.description,
        location: s.filepath,
        priority: s.priority,
        regex: s.originRegex,
        context: s.context,
      })
    }
    return edits
  }

  private async loadAllSnippets(): Promise<HttpResponseItem> {
    this.info(`Loading all sniphub snippets from ${this.config.apiUrl}/snippets`)
    const options: HttpConfig = {
      ...this.baseHttpConfig,
      path: '/snippets',
    }

    if (this.config.apiToken) {
      options.headers = { ...options.headers, Authorization: `Bearer ${this.config.apiToken}` }
    }

    const onEnd: OnEnd = (resolve, reject, body) => {
      try {
        resolve(JSON.parse(Buffer.concat(body).toString()))
      } catch(e) {
        reject(e)
      }
    }

    return promisifyHttpRequest<HttpResponseItem>(options, onEnd)
  }

  private mapItems(): Snippet[] {
    let counter = 0
    return this.sniphubItems.map((item) => {
      const snippet = {
        filepath: item.id,
        lnum: counter,
        body: item.content,
        prefix: item.name,
        description: item.name,
        triggerKind: TriggerKind.WordBoundary,
        filetype: item.language,
      }

      counter = counter + 1

      return snippet
    })
  }

  public getSnippets(filetype: string): Snippet[] {
    return this.mapItems().filter(snippet => this.getFiletypes(filetype).includes(snippet.filetype))
  }

  public async createSnippet(text?: string): Promise<void> {
    const doc = await workspace.document
    const name = await window.requestInput('Snippet Name')

    if (!name) {
      return Promise.resolve()
    }

    // Reinitialize the snippets to see if we saved one with the same name in a previous attempt
    await this.init()

    if (this.mapItems().some(item => item.prefix === name && item.filetype == doc.filetype)) {
      window.showMessage(`Snippet with name ${name} for this filetype already exists`)

      return Promise.resolve()
    }

    const config: HttpConfig = {
      ...this.baseHttpConfig,
      method: 'POST',
      path: '/snippets'
    }

    if (this.config.apiToken) {
      config.headers = { ...config.headers, Authorization: `Bearer ${this.config.apiToken}` }
    }

    const onEnd: OnEnd = (resolve, reject, body) => {
      try {
        resolve(body)
      } catch(e) {
        reject(e)
      }
    }

    const newSnippetRequest = {
      content: text,
      name,
      public: true,
      language: doc.filetype,
    }

    const newSnippet = await promisifyHttpRequest(config, onEnd, JSON.stringify(newSnippetRequest))

    // Add the new snippet so it is available immediately.
    // Calling this.init() here does not work
    this.sniphubItems.push(newSnippet)

    return newSnippet
  }
}

async function promisifyHttpRequest<T = any>(config: HttpConfig, onEnd: OnEnd, body?: string): Promise<T> {
  const options = { headers: {}, ...config}

  if (options.method === 'POST' && body.length) {
    options.headers = {
      ...options.headers,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Content-Length': body.length,
    }
  }

  const { headers, method } = options

  return new Promise(function(resolve, reject) {
    const req = http.request(config.url.toString() + options.path, { headers, method }, function(res) {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error('statusCode=' + res.statusCode));
      }
      const body = []
      res.on('data', function(chunk) {
        body.push(chunk)
      })
      res.on('end', function() {
        onEnd(resolve, reject, body)
      })
    })

    req.on('error', function(err: HttpError) {
      console.log({ err })
      reject(err)
    })

    if (body) {
      req.write(body)
      console.log({ req })
    }

    req.end()
  })
}
