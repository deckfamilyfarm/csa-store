// Retain an uncertain command across retries/reloads. Never silently replace it.
export function memberCommandKey(storage, userId, path, input, newKey = () => crypto.randomUUID()) {
  const slot = `member-command:${userId}:${path}`;
  const body = JSON.stringify(input);
  const previous = JSON.parse(storage.getItem(slot) || 'null');
  if (previous && previous.body !== body) throw new Error('A previous billing request needs confirmation. Retry it before changing the request.');
  const command = previous || {body,key:newKey()};
  storage.setItem(slot,JSON.stringify(command));
  return {key:command.key,complete:()=>storage.removeItem(slot)};
}
