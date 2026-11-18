// A source index is validated before it reaches the approved subtitle store.
// Keep numeric order incrementally so context lookup does not sort and scan
// every approved cue just to retrieve the last eight preceding translations.
function lowerBound(indexes, before) {
    let left = 0, right = indexes.length;
    while (left < right) {
        const middle = left + Math.floor((right - left) / 2);
        if (indexes[middle] < before) left = middle + 1;
        else right = middle;
    }
    return left;
}

class ApprovedCueIndex extends Map {
    #indexes = [];

    constructor(entries = []) {
        super();
        for (const [index, cue] of entries) this.set(index, cue);
    }

    set(index, cue) {
        if (!Number.isSafeInteger(index) || index < 0) throw new TypeError('Invalid approved source index');
        if (index === 0) index = 0; // Map canonicalizes a -0 key to +0.
        if (!this.has(index)) {
            // Normal recognition/translation commits are in ascending order;
            // sparse recovery inserts only genuinely missing source indexes.
            if (!this.#indexes.length || index > this.#indexes.at(-1)) this.#indexes.push(index);
            else this.#indexes.splice(lowerBound(this.#indexes, index), 0, index);
        }
        super.set(index, cue);
        return this;
    }

    delete(index) {
        if (!super.delete(index)) return false;
        this.#indexes.splice(lowerBound(this.#indexes, index), 1);
        return true;
    }

    clear() {
        super.clear();
        this.#indexes.length = 0;
    }

    orderedEntries() {
        // Match a freshly sorted Map snapshot: callers own both the outer
        // array and its entry pairs; cue objects retain their original identity.
        return this.#indexes.map(index => [index, this.get(index)]);
    }

    previousTranslations(before) {
        const after = lowerBound(this.#indexes, before);
        return this.#indexes.slice(Math.max(0, after - 8), after)
            .map(index => ({ index, text: this.get(index).text }));
    }
}

module.exports = { ApprovedCueIndex };
