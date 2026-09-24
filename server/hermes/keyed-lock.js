/**
 * One task at a time per key; tasks on different keys run side by side.
 * A failed task does not block the next one.
 */
const createKeyedLock = () => {
  const locks = new Map();
  return (key, task) => {
    const previous = locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    const tail = next.catch(() => {});
    locks.set(key, tail);
    void tail.then(() => {
      if (locks.get(key) === tail) locks.delete(key);
    });
    return next;
  };
};

module.exports = { createKeyedLock };
