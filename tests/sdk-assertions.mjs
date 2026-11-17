/** Read values from the actual CLI argv recorded by the SDK/CLI fixture. */
export function argumentValue(args, name) {
  const equal = args.find(argument => argument.startsWith(name + '='))
  if (equal !== undefined) return equal.slice(name.length + 1)
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}
