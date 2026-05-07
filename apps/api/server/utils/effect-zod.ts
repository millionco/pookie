import { Effect, Option, Schema, SchemaAST } from "effect"
import z from "zod"

export const ZodOverride: unique symbol = Symbol.for("effect-zod/override")

const walkCache = new WeakMap<SchemaAST.AST, z.ZodTypeAny>()

const EMPTY_PARSE_OPTIONS = {} as SchemaAST.ParseOptions

export const zod = <S extends Schema.Top>(schema: S): z.ZodType<Schema.Schema.Type<S>> =>
  walk(schema.ast) as z.ZodType<Schema.Schema.Type<S>>

export const toJsonSchema = <S extends Schema.Top>(schema: S) =>
  z.toJSONSchema(zod(schema), { io: "input" })

const walk = (ast: SchemaAST.AST): z.ZodTypeAny => {
  const cached = walkCache.get(ast)
  if (cached) return cached
  const result = walkUncached(ast)
  walkCache.set(ast, result)
  return result
}

const walkUncached = (ast: SchemaAST.AST): z.ZodTypeAny => {
  const override = (ast.annotations as any)?.[ZodOverride] as z.ZodTypeAny | undefined
  const base = override ?? bodyWithChecks(ast)
  const desc = SchemaAST.resolveDescription(ast)
  const ref = SchemaAST.resolveIdentifier(ast)
  const described = desc ? base.describe(desc) : base
  return ref ? described.meta({ ref }) : described
}

const bodyWithChecks = (ast: SchemaAST.AST): z.ZodTypeAny => {
  // Schema.Class wraps its fields in a Declaration AST plus an encoding that
  // constructs the class instance. For the Zod derivation we want the plain
  // field shape (the decoded/consumer view), not the class instance — so
  // Declarations fall through to body(), not encoded(). User-level
  // Schema.decodeTo / Schema.transform attach encoding to non-Declaration
  // nodes, where we do apply the transform.
  //
  // Schema.withDecodingDefault also attaches encoding, but we want `.default(v)`
  // on the inner Zod rather than a transform wrapper — so optional ASTs whose
  // encoding resolves a default from Option.none() route through body()/opt().
  const hasEncoding = ast.encoding?.length && (ast._tag !== "Declaration" || ast.typeParameters.length === 0)
  const hasTransform = hasEncoding && !(SchemaAST.isOptional(ast) && extractDefault(ast) !== undefined)
  const base = hasTransform ? encoded(ast) : body(ast)
  return ast.checks?.length ? applyChecks(base, ast.checks, ast) : base
}

// Transformations built via pure `SchemaGetter.transform(fn)` (the common
// decodeTo case) resolve synchronously, so running with no services is safe.
// Effectful / middleware-based transforms will surface as Effect defects.
const decode = (transformation: SchemaAST.Link["transformation"], value: unknown): unknown => {
  const exit = Effect.runSyncExit(
    (transformation.decode as any).run(Option.some(value), EMPTY_PARSE_OPTIONS) as Effect.Effect<
      Option.Option<unknown>
    >,
  )
  if (exit._tag === "Failure") throw new Error(`effect-zod: transform failed: ${String(exit.cause)}`)
  return Option.getOrElse(exit.value, () => value)
}

const encoded = (ast: SchemaAST.AST): z.ZodTypeAny => {
  const encoding = ast.encoding!
  return encoding.reduce<z.ZodTypeAny>(
    (acc, link) => acc.transform((value) => decode(link.transformation, value)),
    walk(encoding[0].to),
  )
}

const applyChecks = (out: z.ZodTypeAny, checks: SchemaAST.Checks, ast: SchemaAST.AST): z.ZodTypeAny => {
  const filters: SchemaAST.Filter<unknown>[] = []
  const collect = (check: SchemaAST.Check<unknown>) => {
    if (check._tag === "FilterGroup") check.checks.forEach(collect)
    else filters.push(check)
  }
  checks.forEach(collect)

  const unhandled: SchemaAST.Filter<unknown>[] = []
  const translated = filters.reduce<z.ZodTypeAny>((acc, filter) => {
    const next = translateFilter(acc, filter)
    if (next) return next
    unhandled.push(filter)
    return acc
  }, out)

  if (unhandled.length === 0) return translated

  return translated.superRefine((value, ctx) => {
    for (const filter of unhandled) {
      const issue = filter.run(value, ast, EMPTY_PARSE_OPTIONS)
      if (!issue) continue
      const message = issueMessage(issue) ?? (filter.annotations as any)?.message ?? "Validation failed"
      ctx.addIssue({ code: "custom", message })
    }
  })
}

const translateFilter = (out: z.ZodTypeAny, filter: SchemaAST.Filter<unknown>): z.ZodTypeAny | undefined => {
  const meta = (filter.annotations as { meta?: Record<string, unknown> } | undefined)?.meta
  if (!meta || typeof meta._tag !== "string") return undefined
  switch (meta._tag) {
    case "isInt":
      return call(out, "int")
    case "isFinite":
      return call(out, "finite")
    case "isGreaterThan":
      return call(out, "gt", meta.exclusiveMinimum)
    case "isGreaterThanOrEqualTo":
      return call(out, "gte", meta.minimum)
    case "isLessThan":
      return call(out, "lt", meta.exclusiveMaximum)
    case "isLessThanOrEqualTo":
      return call(out, "lte", meta.maximum)
    case "isBetween": {
      const lower = meta.exclusiveMinimum ? call(out, "gt", meta.minimum) : call(out, "gte", meta.minimum)
      if (!lower) return undefined
      return meta.exclusiveMaximum ? call(lower, "lt", meta.maximum) : call(lower, "lte", meta.maximum)
    }
    case "isMultipleOf":
      return call(out, "multipleOf", meta.divisor)
    case "isMinLength":
      return call(out, "min", meta.minLength)
    case "isMaxLength":
      return call(out, "max", meta.maxLength)
    case "isLengthBetween": {
      const lower = call(out, "min", meta.minimum)
      if (!lower) return undefined
      return call(lower, "max", meta.maximum)
    }
    case "isPattern":
      return call(out, "regex", meta.regExp)
    case "isStartsWith":
      return call(out, "startsWith", meta.startsWith)
    case "isEndsWith":
      return call(out, "endsWith", meta.endsWith)
    case "isIncludes":
      return call(out, "includes", meta.includes)
    case "isUUID":
      return call(out, "uuid")
    case "isULID":
      return call(out, "ulid")
    case "isBase64":
      return call(out, "base64")
    case "isBase64Url":
      return call(out, "base64url")
  }
  return undefined
}

const call = (target: z.ZodTypeAny, method: string, ...args: unknown[]): z.ZodTypeAny | undefined => {
  const fn = (target as unknown as Record<string, ((...a: unknown[]) => z.ZodTypeAny) | undefined>)[method]
  return typeof fn === "function" ? fn.apply(target, args) : undefined
}

const issueMessage = (issue: any): string | undefined => {
  if (typeof issue?.annotations?.message === "string") return issue.annotations.message
  if (typeof issue?.message === "string") return issue.message
  return undefined
}

const body = (ast: SchemaAST.AST): z.ZodTypeAny => {
  if (SchemaAST.isOptional(ast)) return opt(ast)

  switch (ast._tag) {
    case "String":
      return z.string()
    case "Number":
      return z.number()
    case "Boolean":
      return z.boolean()
    case "Null":
      return z.null()
    case "Undefined":
      return z.undefined()
    case "Any":
    case "Unknown":
      return z.unknown()
    case "Never":
      return z.never()
    case "Literal":
      return z.literal(ast.literal)
    case "Union":
      return union(ast)
    case "Objects":
      return object(ast)
    case "Arrays":
      return array(ast)
    case "Declaration":
      return decl(ast)
    default:
      return fail(ast)
  }
}

const opt = (ast: SchemaAST.AST): z.ZodTypeAny => {
  if (ast._tag !== "Union") return fail(ast)
  const items = ast.types.filter((item) => item._tag !== "Undefined")
  const inner =
    items.length === 1
      ? walk(items[0])
      : items.length > 1
        ? z.union(items.map(walk) as [z.ZodTypeAny, z.ZodTypeAny, ...Array<z.ZodTypeAny>])
        : z.undefined()
  // Schema.withDecodingDefault attaches an encoding `Link` whose transformation
  // decode Getter resolves `Option.none()` to `Option.some(default)`. Invoke
  // it to extract the default and emit `.default(...)` instead of `.optional()`.
  const fallback = extractDefault(ast)
  if (fallback !== undefined) return inner.default(fallback.value)
  return inner.optional()
}

interface DecodeLink {
  readonly transformation: {
    readonly decode: {
      readonly run: (
        input: Option.Option<unknown>,
        options: SchemaAST.ParseOptions,
      ) => Effect.Effect<Option.Option<unknown>, unknown>
    }
  }
}

const extractDefault = (ast: SchemaAST.AST): { value: unknown } | undefined => {
  const encoding = (ast as { encoding?: ReadonlyArray<DecodeLink> }).encoding
  if (!encoding?.length) return undefined
  // Walk the chain of encoding Links in order; the first Getter that produces
  // a value from Option.none wins. withDecodingDefault always puts its
  // defaulting Link adjacent to the optional Union.
  for (const link of encoding) {
    const probe = Effect.runSyncExit(link.transformation.decode.run(Option.none(), {}))
    if (probe._tag !== "Success") continue
    if (Option.isSome(probe.value)) return { value: probe.value.value }
  }
  return undefined
}

const union = (ast: SchemaAST.Union): z.ZodTypeAny => {
  if (ast.types.length >= 2 && ast.types.every((memberType) => memberType._tag === "Literal" && typeof memberType.literal === "string")) {
    return z.enum(ast.types.map((memberType) => (memberType as SchemaAST.Literal).literal as string) as [string, ...string[]])
  }

  const items = ast.types.map(walk)
  if (items.length === 1) return items[0]
  if (items.length < 2) return fail(ast)

  const discriminator = ast.annotations?.discriminator
  if (typeof discriminator === "string") {
    return z.discriminatedUnion(discriminator, items as [z.ZodObject<any>, z.ZodObject<any>, ...z.ZodObject<any>[]])
  }

  return z.union(items as [z.ZodTypeAny, z.ZodTypeAny, ...Array<z.ZodTypeAny>])
}

const object = (ast: SchemaAST.Objects): z.ZodTypeAny => {
  if (ast.propertySignatures.length === 0 && ast.indexSignatures.length === 1) {
    const sig = ast.indexSignatures[0]
    if (sig.parameter._tag !== "String") return fail(ast)
    return z.record(z.string(), walk(sig.type))
  }

  if (ast.indexSignatures.length === 0) {
    return z.object(Object.fromEntries(ast.propertySignatures.map((sig) => [String(sig.name), walk(sig.type)])))
  }

  if (ast.indexSignatures.length !== 1) return fail(ast)
  const sig = ast.indexSignatures[0]
  if (sig.parameter._tag !== "String") return fail(ast)
  return z
    .object(Object.fromEntries(ast.propertySignatures.map((propSig) => [String(propSig.name), walk(propSig.type)])))
    .catchall(walk(sig.type))
}

const array = (ast: SchemaAST.Arrays): z.ZodTypeAny => {
  if (ast.elements.length === 0) {
    if (ast.rest.length !== 1) return fail(ast)
    return z.array(walk(ast.rest[0]))
  }
  if (ast.rest.length > 0) return fail(ast)
  const items = ast.elements.map(walk)
  return z.tuple(items as [z.ZodTypeAny, ...Array<z.ZodTypeAny>])
}

const decl = (ast: SchemaAST.Declaration): z.ZodTypeAny => {
  if (ast.typeParameters.length !== 1) return fail(ast)
  return walk(ast.typeParameters[0])
}

const fail = (ast: SchemaAST.AST): never => {
  const ref = SchemaAST.resolveIdentifier(ast)
  throw new Error(`unsupported effect schema: ${ref ?? ast._tag}`)
}
