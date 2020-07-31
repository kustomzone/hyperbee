const { YoloIndex, Node } = require('./messages')
const { Readable } = require('streamx')

const MAX_CHILDREN = 3

class Key {
  constructor (seq, value) {
    this.seq = seq
    this.value = value
  }
}

class Child {
  constructor (seq, offset, value) {
    this.seq = seq
    this.offset = offset
    this.value = value
  }
}

class Pointers {
  constructor (buf) {
    this.levels = YoloIndex.decode(buf).levels.map(l => {
      const children = []
      const keys = []

      for (let i = 0; i < l.keys.length; i++) {
        keys.push(new Key(l.keys[i], null))
      }

      for (let i = 0; i < l.children.length; i += 2) {
        children.push(new Child(l.children[i], l.children[i + 1], null))
      }

      return { keys, children }
    })
  }

  get (i) {
    return this.levels[i]
  }
}

function inflate (buf) {
  return new Pointers(buf)
}

function deflate (index) {
  const levels = index.map(l => {
    const keys = []
    const children = []

    for (let i = 0; i < l.keys.length; i++) {
      keys.push(l.keys[i].seq)
    }

    for (let i = 0; i < l.children.length; i++) {
      children.push(l.children[i].seq, l.children[i].offset)
    }

    return { keys, children }
  })


  return YoloIndex.encode({ levels })
}

class TreeNode {
  constructor (block, keys, children) {
    this.block = block
    this.keys = keys
    this.children = children
    this.changed = false
  }

  async insertKey (key, child = null) {
    let s = 0
    let e = this.keys.length
    let c

    while (s < e) {
      const mid = (s + e) >> 1
      c = cmp(key.value, await this.getKey(mid))

      if (c === 0) {
        this.changed = true
        this.keys[mid] = key
        return true
      }

      if (c < 0) e = mid
      else s = mid + 1
    }

    const i = c < 0 ? e : s
    this.keys.splice(i, 0, key)
    if (child) this.children.splice(i + 1, 0, new Child(0, 0, child))
    this.changed = true

    return this.keys.length < MAX_CHILDREN
  }

  async split () {
    const len = this.keys.length >> 1
    const right = TreeNode.create(this.block.tree)

    while (right.keys.length < len) right.keys.push(this.keys.pop())
    right.keys.reverse()

    const median = this.keys.pop()

    if (this.children.length) {
      while (right.children.length < len + 1) right.children.push(this.children.pop())
      right.children.reverse()
    }

    this.changed = true

    return {
      left: this,
      median,
      right
    }
  }

  async getChildNode (index) {
    const child = this.children[index]
    if (child.value) return child.value
    const block = child.seq === this.block.seq ? this.block : await this.block.tree.getBlock(child.seq)
    return (child.value = block.getTreeNode(child.offset))
  }

  setKey (index, key) {
    this.keys[index] = key
    this.changed = true
  }

  async getKey (index) {
    const key = this.keys[index]
    if (key.value) return key.value
    const k = key.seq === this.block.seq ? this.block.key : await this.block.tree.getKey(key.seq)
    return (key.value = k)
  }

  buildIndex (index, seq) {
    const offset = index.push(null) - 1
    const keys = this.keys
    const children = []

    for (const child of this.children) {
      if (!child.value || !child.value.changed) {
        children.push(child)
      } else {
        children.push(new Child(seq, child.value.buildIndex(index, seq)))
      }
    }

    index[offset] = { keys, children }
    return offset
  }

  static create (block) {
    const node = new TreeNode(block, [], [])
    node.changed = true
    return node
  }
}

class BlockEntry {
  constructor (seq, tree, entry) {
    this.seq = seq
    this.tree = tree
    this.index = null
    this.indexBuffer = entry.index
    this.key = entry.key
    this.value = entry.value
  }

  getTreeNode (offset) {
    if (this.index === null) {
      this.index = inflate(this.indexBuffer)
      this.indexBuffer = null
    }
    const entry = this.index.get(offset)
    return new TreeNode(this, entry.keys, entry.children)
  }
}

class BTree {
  constructor (feed) {
    this.feed = feed
  }

  ready () {
    return new Promise((resolve, reject) => {
      this.feed.ready(err => {
        if (err) return reject(err)
        if (this.feed.length > 1) return resolve()

        this.feed.append('header', (err) => {
          if (err) return reject(err)
          resolve()
        })
      })
    })
  }

  async getRoot (batch = this) {
    await this.ready()

    if (this.feed.length < 2) return null
    return (await this.getBlock(this.feed.length - 1, this)).getTreeNode(0)
  }

  async getKey (seq) {
    return (await this.getBlock(seq)).key
  }

  async getBlock (seq, batch = this) {
    return new Promise((resolve, reject) => {
      this.feed.get(seq, { valueEncoding: Node }, (err, entry) => {
        if (err) return reject(err)
        resolve(new BlockEntry(seq, batch, entry))
      })
    })
  }

  createReadStream () {
    return createReadStream(this)
  }

  get (key) {
    const b = new Batch(this)
    return b.get(key)
  }

  put (key, value) {
    const b = new Batch(this)
    return b.put(key, value)
  }

  async debugToString () {
    return require('tree-to-string')(await load(await this.getRoot()))

    async function load (node) {
      const res = { values: [], children: [] }
      for (let i = 0; i < node.keys.length; i++) {
        res.values.push((await node.getKey(i)).toString())
      }
      for (let i = 0; i < node.children.length; i++) {
        res.children.push(await load(await node.getChildNode(i)))
      }
      return res
    }
  }
}

class Batch {
  constructor (tree) {
    this.tree = tree
    this.blocks = new Map()
  }

  ready () {
    return this.tree.ready()
  }

  async getRoot () {
    return this.tree.getRoot(this)
  }

  async getKey (seq) {
    return (await this.getBlock(seq)).key
  }

  async getBlock (seq) {
    let b = this.blocks.get(seq)
    if (b) return b
    b = await this.tree.getBlock(seq, this)
    this.blocks.set(seq, b)
    return b
  }

  async get (key) {
    let node = await this.getRoot()
    if (!node) return null

    while (true) {
      let s = 0
      let e = node.keys.length
      let c

      while (s < e) {
        const mid = (s + e) >> 1
        c = cmp(key, await node.getKey(mid))

        if (c === 0) {
          return this.getBlock(node.keys[mid].seq)
        }

        if (c < 0) e = mid
        else s = mid + 1
      }

      if (!node.children.length) return null

      const i = c < 0 ? e : s
      node = await node.getChildNode(i)
    }
  }

  async put (key, value) {
    if (typeof key === 'string') key = Buffer.from(key)

    const index = []
    const stack = []

    let root
    let node = root = await this.getRoot()

    const seq = this.tree.feed.length
    const target = new Key(seq, key)

    if (!node) {
      await this.append({
        key: target.value,
        index: deflate([{ keys: [target], children: [] }])
      })
      return
    }

    while (node.children.length) {
      stack.push(node)
      node.changed = true // changed, but compressible

      let s = 0
      let e = node.keys.length
      let c

      while (s < e) {
        const mid = (s + e) >> 1
        c = cmp(target.value, await node.getKey(mid))

        if (c === 0) {
          node.setKey(mid, target)
          return this._append(root, seq, key, value)
        }

        if (c < 0) e = mid
        else s = mid + 1
      }

      const i = c < 0 ? e : s
      node = await node.getChildNode(i)
    }

    let needsSplit = !(await node.insertKey(target, null))

    while (needsSplit) {
      const parent = stack.pop()
      const { median, right } = await node.split()

      if (parent) {
        needsSplit = !(await parent.insertKey(median, right))
        node = parent
      } else {
        root = TreeNode.create(node.block)
        root.changed = true
        root.keys.push(median)
        root.children.push(new Child(0, 0, node), new Child(0, 0, right))
        needsSplit = false
      }
    }

    return this._append(root, seq, key, value)
  }

  _append (root, seq, key, value) {
    const index = []

    root.buildIndex(index, seq)

    return this.append({
      key,
      value,
      index: deflate(index)
    })
  }

  append (raw) {
    return new Promise((resolve, reject) => {
      this.tree.feed.append(Node.encode(raw), err => {
        if (err) return reject(err)
        resolve()
      })
    })
  }
}

function createReadStream (tree, opts) {
  const stack = []

  return new Readable({
    open (cb) {
      call(open(this), cb)
    },
    read (cb) {
      call(next(this), cb)
    }
  })

  function call (p, cb) {
    p.then((val) => process.nextTick(cb, null, val), (err) => process.nextTick(cb, err))
  }

  async function next (stream) {
    while (stack.length) {
      const top = stack[stack.length - 1]
      const isKey = (top.i & 1) === 1
      const n = top.i++ >> 1

      if (!isKey) {
        if (!top.node.children.length) continue
        stack.push({ i: 0, node: await top.node.getChildNode(n) })
        continue
      }

      if (n >= top.node.keys.length) {
        stack.pop()
        continue
      }

      const key = top.node.keys[n]
      stream.push(await tree.getBlock(key.seq))
      return
    }

    stream.push(null)
  }

  async function open () {
    let node = await tree.getRoot()

    while (true) {
      const entry = { node, i: 0 }
      stack.push(entry)
      if (!node.children.length) break
      entry.i++
      node = await node.getChildNode(0)
    }
  }
}


function cmp (a, b) {
  return a < b ? -1 : b < a ? 1 : 0
}

module.exports = BTree

if (require.main !== module) return

const t = new BTree(require('hypercore')('./data2'))
let debug = 0

main()

async function main () {
  // await t.put('b', Buffer.from('some b stuff'))
// console.log(await t.debugToString())

  const i = t.createReadStream()
  const sp = require('speedometer')()
  let cnt = 0

  const s = setInterval(function () {
    console.log(cnt, sp())
  }, 1000)

  i.on('data', function (data) {
    // console.log(cnt, data.key)
    cnt++
    sp(1)
  })

  i.on('end', function () {
    clearInterval(s)
    console.log(cnt, sp())
  })

return
  console.log(await t.get('b'))
  console.log(await t.get('aa'))
  console.log(await t.get('bb'))
// return
  let max = 0
  const speed = require('speedometer')()
  setInterval(function () {
    console.log(t.feed.length, speed())
  }, 1000)
  while (true) {
    // const then = Date.now()
    await t.put(Math.random().toString(16).slice(2))
    // const delta = Date.now() - then
    // if (delta > max) console.log(max = delta, t.feed.length)
    speed(1)
    // console.log(t.feed.length)
  }
  // await t.put('hi')
  // await t.put('ho')
  // // debug = 1
  // await t.put('ha')
  // // debug = 0
  // await t.put('a')
  // await t.put('b', Buffer.from('some b stuff'))
  // await t.put('c')
  // await t.put('d')
  // await t.put('a!')
  // await t.put('a!!')
  // // console.log(t.feed.length)
  // // console.log(await t.getRoot())
  // await t.put('a!!!')
  // await t.put('a!!!!')
  // await t.put('a!!!!!')
  // debug = 1
  // await t.put('a!')
  // console.log('---')


  // console.log(await t.get('b'))
  // console.log(t)
}

// const arr = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n']
// const res = bisect('!', arr, cmp)

// console.log(res)