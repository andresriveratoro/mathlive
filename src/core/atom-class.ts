import { isArray } from '../common/types';

import { Context, ContextInterface } from './context';
import { Style, ParseMode } from '../public/core';
import { MATHSTYLES } from './mathstyle';
import { METRICS as FONTMETRICS } from './font-metrics';
import {
    makeSpan,
    makeVlist,
    depth as spanDepth,
    height as spanHeight,
    italic as spanItalic,
    SpanType,
    isSpanType,
    Span,
} from './span';
import { joinLatex } from './tokenizer';
import { emitLatexRun, getModeRuns, getPropertyRuns } from './modes-utils';
import { charToLatex } from '../core-definitions/definitions-utils';

export const ATOM_REGISTRY = {};

export type BranchName =
    | 'above'
    | 'body'
    | 'below'
    | 'superscript'
    | 'subscript';
export type Branch = BranchName | [row: number, col: number];
/**
 * The order of these branches specify the keyboard navigation order
 */
export const NAMED_BRANCHES: BranchName[] = [
    'above',
    'body',
    'below',
    'superscript',
    'subscript',
];

/**
 * A "branch" is a set of children of an atom.
 * There are two kind of branches:
 * - **colRow** branches are used with array type of atoms. They are addressed
 * with a column and row number
 * - **named branches** used with other kind of atom. There is a fixed set of
 * possible named branches.
 */
export function isNamedBranch(branch: Branch): branch is BranchName {
    return typeof branch === 'string' && NAMED_BRANCHES.includes(branch);
}

function isColRowBranch(branch: Branch): branch is [number, number] {
    return Array.isArray(branch) && branch.length === 2;
}

export type Branches = {
    [branch in BranchName]?: Atom[];
};

export type ToLatexOptions = {
    expandMacro?: boolean;
};

export type AtomType =
    | ''
    | 'accent'
    | 'array' // a group, which has children arranged in rows. Used
    // by environments such as `matrix`, `cases`, etc...
    | 'box' // a border drawn around an expression and change its background color
    | 'chem' // a chemical formula (mhchem)
    | 'command' // command` indicate a command being entered. The text is displayed in blue in the editor.
    | 'composition' // IME composition area
    | 'delim'
    | 'enclose'
    | 'error' //  an unknown command, for example `\xyzy`. The text  is displayed with a wavy red underline in the editor.
    | 'first' // a special, empty, atom put as the first atom in math lists in
    // order to be able to position the caret before the first element. Aside from
    // the caret, they display nothing.
    | 'genfrac' // a generalized fraction: a numerator and denominator, separated
    // by an optional line, and surrounded by optional fences
    | 'group' // a simple group of atoms, for example from a `{...}`
    | 'leftright' // used by the `\left` and `\right` commands
    | 'line' // used by `\overline` and `\underline`
    | 'macro'
    | 'mbin' // binary operator: `+`, `*`, etc...
    | 'mclose' // closing fence: `)`, `\rangle`, etc...
    | 'minner' // special layout cases, overlap, `\left...\right`
    | 'mop' // `mop`: operators, including special functions, `\sin`, `\sum`, `\cap`.
    | 'mopen' // opening fence: `(`, `\langle`, etc...
    | 'mord' // ordinary symbol, e.g. `x`, `\alpha`
    | 'mpunct' // punctuation: `,`, `:`, etc...
    | 'mrel' // relational operator: `=`, `\ne`, etc...
    | 'msubsup'
    | 'none' // @revisit
    | 'overlap' // display a symbol _over_ another
    | 'overunder' // displays an annotation above or below a symbol
    | 'placeholder' // a temporary item. Placeholders are displayed as a dashed square in the editor.
    | 'phantom'
    | 'root' // a group, which has no parent (only one per formula)
    | 'rule' // draw a line, for the `\rule` command
    | 'sizeddelim' // a delimiter that can grow
    | 'space'
    | 'spacing'
    | 'surd' // aka square root, nth root
    | 'text' // text mode atom
    | 'textord';

export type BBoxParam = {
    backgroundcolor?: string;
    padding?: number;
    border?: string;
};

// A table of size -> font size for the different sizing functions
const SIZING_MULTIPLIER = {
    size1: 0.5,
    size2: 0.7,
    size3: 0.8,
    size4: 0.9,
    size5: 1.0,
    size6: 1.2,
    size7: 1.44,
    size8: 1.73,
    size9: 2.07,
    size10: 2.49,
};

/**
 * An atom is an object encapsulating an elementary mathematical unit,
 * independent of its graphical representation.
 *
 * It keeps track of the content, while the dimensions, position and style
 * are tracked by Span objects which are created by the `decompose()` functions.
 *
 * @property mode - `'display'`, `'command'`, etc...
 *
 * In addition to these basic types, which correspond to the TeX atom types,
 * some atoms represent more complex compounds, including:
 * - `space` and `spacing`: blank space between atoms
 * - `mathstyle`: to change the math style used: `display` or `text`.
 * The layout rules are different for each, the latter being more compact and
 * intended to be incorporated with surrounding non-math text.
 *
 *
 * @property captureSelection if true, this atom does not let its
 * children be selected. Used by the `\enclose` annotations, for example.
 *
 * @property skipBoundary if true, when the caret reaches the
 * first position in this element's body, it automatically moves to the
 * outside of the element. Conversely, when the caret reaches the position
 * right after this element, it automatically moves to the last position
 * inside this element.
 */
export class Atom {
    parent: Atom | null;
    // An atom can have multiple "branches" of children,
    // e.g. `body` and `superscript`
    // The `treeBranch` property indicate which branch of the parent this
    // atom belongs to or if in an array, the row and column
    treeBranch: Branch | [number, number];

    // Used to match a DOM element to an Atom
    // (the corresponding DOM element has a `data-atom-id` attribute)
    id?: string;

    // If true, some structural changes have been made to the atom
    // (insertion or removal of children) or one of its children is dirty
    _isDirty: boolean;
    // Cached list of children, invalidated when isDirty = true
    _children: Atom[];

    type: AtomType;

    // Latex command ('\sin') or character ('a')
    command: string;
    // If true, the atom is an extensible symbol (affects layout of supsub)
    isExtensibleSymbol: boolean;
    // If true, the atom represents a function (which can be followed by parentheses)
    // e.g. "f" or "\sin"
    isFunction: boolean;

    skipBoundary?: boolean;
    captureSelection?: boolean;

    isSelected: boolean;
    // If the atom or one of its descendant includes the caret
    // (used to highligth surd or fences to make clearer where the caret is
    containsCaret: boolean;
    caret: ParseMode | '';

    // Verbatim Latex of the command and its arguments
    latex?: string;

    // Optional, per instance, override of the `toLatex()` method
    toLatexOverride?: (atom: Atom, options: ToLatexOptions) => string;

    // How to display "limits" (i.e. superscript/subscript) for example
    // with `\sum`:
    // - 'limits': above and below the symbold
    // - 'nolimits': in superscript and subscript positions (for example
    // when in `textstyle`)
    limits?: 'limits' | 'nolimits' | 'accent' | 'overunder' | 'auto';
    // True if the limits were set by a command
    explicitLimits?: boolean;

    value: string;
    private branches: Branches;

    private maxFontSize?: number;

    // mathstyle?:
    //     | 'auto'
    //     | 'displaystyle'
    //     | 'textstyle'
    //     | 'scriptstyle'
    //     | 'scriptscriptstyle'; // type = 'genfrac', ''

    style: Style;
    mode: ParseMode;

    // color?: string;
    // backgroundColor?: string;
    // variant?: Variant;
    // variantStyle?: VariantStyle;
    // fontFamily?: string;
    // fontShape?: FontShape;
    // fontSeries?: FontSeries;
    // fontSize?: string;
    // cssId?: string;
    // cssClass?: string; // A single CSS class, as a style decoration
    // letterShapeStyle?: 'tex' | 'french' | 'iso' | 'upright' | 'auto';

    constructor(
        type: AtomType,
        options?: {
            command?: string;
            mode?: ParseMode;
            value?: string;
            isExtensibleSymbol?: boolean;
            isFunction?: boolean;
            limits?: 'limits' | 'nolimits' | 'accent' | 'overunder' | 'auto';
            style?: Style;
            toLatexOverride?: (atom: Atom, options: ToLatexOptions) => string;
        }
    ) {
        this.command = options?.command;
        this.type = type;
        if (typeof options?.value === 'string') {
            this.value = options.value;
        }
        this._isDirty = false;

        this.mode = options?.mode ?? 'math';
        this.isExtensibleSymbol = options?.isExtensibleSymbol ?? false;
        this.isFunction = options?.isFunction ?? false;
        this.limits = options?.limits;
        this.style = options?.style ?? {};
        this.toLatexOverride = options?.toLatexOverride;
    }
    get isDirty(): boolean {
        return this._isDirty;
    }
    set isDirty(dirty: boolean) {
        this._isDirty = dirty;
        if (dirty) {
            this.latex = undefined;
            this._children = null;
            let parent = this.parent;
            while (parent) {
                parent._isDirty = true;
                parent._children = null;
                parent.latex = undefined;
                parent = parent.parent;
            }
        }
    }

    /**
     * Return a list of spans equivalent to atoms.
     * A span is the most elementary type possible, for example 'text'
     * or 'vlist', while the input atoms may be more abstract and complex,
     * such as 'genfrac'
     *
     * @param context Font family, variant, size, color, and other info useful
     * to render an expression
     * @param atoms - An array of atoms
     */
    static render(
        inputContext: ContextInterface,
        atoms: Atom[] | undefined
    ): Span[] | null {
        function isDigit(atom: Atom): boolean {
            return (
                atom.type === 'mord' &&
                Boolean(atom.value) &&
                /^[0-9,.]$/.test(atom.value)
            );
        }
        function isText(atom: Atom): boolean {
            return atom.mode === 'text';
        }
        if (!atoms) return null;
        if (atoms.length === 0) return [];

        // We can be passed either a Context object, or
        // a ContextInterface objectl literal.
        const context: Context =
            inputContext instanceof Context
                ? inputContext
                : new Context(inputContext);

        // In most cases we want to display selection,
        // except if the `atomIdsSettings.groupNumbers` flag is set which is used for
        // read aloud.
        const displaySelection =
            !context.atomIdsSettings || !context.atomIdsSettings.groupNumbers;

        let result: Span[] | null = [];
        if (atoms.length === 1) {
            result = atoms[0].render(context);
            if (result && displaySelection && atoms[0].isSelected) {
                result.forEach((x: Span) => x.selected(true));
            }
            console.assert(!result || isArray(result));
        } else {
            let selection: Span[] = [];
            let digitOrTextStringID = '';
            let lastWasDigit = true;
            for (let i = 0; i < atoms.length; i++) {
                if (
                    context.atomIdsSettings?.groupNumbers &&
                    digitOrTextStringID &&
                    ((lastWasDigit && isDigit(atoms[i])) ||
                        (!lastWasDigit && isText(atoms[i])))
                ) {
                    context.atomIdsSettings.overrideID = digitOrTextStringID;
                }
                const span: Span[] = atoms[i].render(context);
                if (context.atomIdsSettings) {
                    context.atomIdsSettings.overrideID = null;
                }
                if (span) {
                    // Flatten the spans (i.e. [[a1, a2], b1, b2] -> [a1, a2, b1, b2]
                    const flat = [].concat(...span);
                    context.phantomBase = flat;

                    // If this is a digit or text run, keep track of it
                    if (context.atomIdsSettings?.groupNumbers) {
                        if (isDigit(atoms[i]) || isText(atoms[i])) {
                            if (
                                !digitOrTextStringID ||
                                lastWasDigit !== isDigit(atoms[i])
                            ) {
                                // changed from text to digits or vice-versa
                                lastWasDigit = isDigit(atoms[i]);
                                digitOrTextStringID = atoms[i].id;
                            }
                        }
                        if (
                            (!(isDigit(atoms[i]) || isText(atoms[i])) ||
                                !atoms[i].hasEmptyBranch('superscript') ||
                                !atoms[i].hasEmptyBranch('subscript')) &&
                            digitOrTextStringID
                        ) {
                            // Done with digits/text
                            digitOrTextStringID = '';
                        }
                    }

                    if (displaySelection && atoms[i].isSelected) {
                        selection = selection.concat(flat);
                        selection.forEach((x: Span) => x.selected(true));
                    } else {
                        if (selection.length > 0) {
                            // There was a selection, but we're out of it now
                            // Append the selection
                            result = [...result, ...selection];
                            selection = [];
                        }
                        result = result.concat(flat);
                    }
                }
            }

            // Is there a leftover selection?
            if (selection.length > 0) {
                result = [...result, ...selection];
                selection = [];
            }
        }

        if (!result || result.length === 0) return null;

        // If the mathstyle changed between the parent and the current atom,
        // account for the size difference
        if (context.mathstyle.id !== context.parentMathstyle.id) {
            const factor =
                context.mathstyle.sizeMultiplier /
                context.parentMathstyle.sizeMultiplier;
            for (const span of result) {
                console.assert(!isArray(span));
                console.assert(
                    typeof span.height === 'number' && isFinite(span.height)
                );
                span.height *= factor;
                span.depth *= factor;
            }
        }
        // If the size changed between the parent and the current group,
        // account for the size difference
        if (context.size !== context.parentSize) {
            const factor =
                SIZING_MULTIPLIER[context.size] /
                SIZING_MULTIPLIER[context.parentSize];
            for (const span of result) {
                console.assert(!isArray(span));
                console.assert(
                    typeof span.height === 'number' && isFinite(span.height)
                );
                span.height *= factor;
                span.depth *= factor;
            }
        }

        return result;
    }

    /**
     * Given an atom or an array of atoms, return a LaTeX string representation
     */
    static toLatex(
        value: boolean | number | string | Atom | Atom[],
        options: ToLatexOptions
    ): string {
        let result = '';
        if (isArray(value)) {
            if (value.length > 0) result = atomsToLatex(value, options);
        } else if (typeof value === 'number' || typeof value === 'boolean') {
            result = value.toString();
        } else if (typeof value === 'string') {
            result = value.replace(/\s/g, '~');
        } else if (typeof value !== 'undefined') {
            // If we have some verbatim latex for this atom, use it.
            // This allow non-significant punctuation to be preserved when possible.
            if (!options.expandMacro && typeof value.latex === 'string') {
                return value.latex;
            }
            if (value.toLatexOverride) {
                return value.toLatexOverride(value, options);
            }
            result = value.toLatex(options);
        }
        return result;
    }
    // Default Latex emmiter.
    // Avoid calling directly, instead call `Atom.toLatex(atom)`
    // to correctly call per-definition emitters and use the cached verbatim
    // latex when applicable.
    toLatex(options: ToLatexOptions): string {
        if (this.body && this.command) {
            // There's a command and body
            return joinLatex([
                this.command,
                '{',
                this.bodyToLatex(options),
                '}',
                this.supsubToLatex(options),
            ]);
        }
        if (this.body) {
            // There's a body with no command
            return joinLatex([
                this.bodyToLatex(options),
                this.supsubToLatex(options),
            ]);
        }
        if (this.value && this.value !== '\u200b') {
            // There's probably just a value (which is a unicode character)
            return charToLatex(this.mode, this.value) ?? this.command;
        }

        return '';
    }
    bodyToLatex(options: ToLatexOptions): string {
        return Atom.toLatex(this.body, options);
    }
    aboveToLatex(options: ToLatexOptions): string {
        return Atom.toLatex(this.above, options);
    }
    belowToLatex(options: ToLatexOptions): string {
        return Atom.toLatex(this.below, options);
    }
    supsubToLatex(options: ToLatexOptions): string {
        let result = '';
        if (!this.hasEmptyBranch('superscript')) {
            let sup = Atom.toLatex(this.superscript, options);
            if (sup.length === 1) {
                if (sup === '\u2032') {
                    sup = '\\prime ';
                } else if (sup === '\u2033') {
                    sup = '\\doubleprime ';
                }
                result += '^' + sup;
            } else {
                result += '^{' + sup + '}';
            }
        }
        if (!this.hasEmptyBranch('subscript')) {
            const sub = Atom.toLatex(this.subscript, options);
            if (sub.length === 1) {
                result += '_' + sub;
            } else {
                result += '_{' + sub + '}';
            }
        }
        return result;
    }
    get treeDepth(): number {
        let result = 1;
        let atom = this.parent;
        while (atom) {
            atom = atom.parent;
            result += 1;
        }
        return result;
    }
    /**
     * Return the atoms in the branch, if it exists, otherwise null
     */
    branch(name: Branch | [col: number, row: number]): Atom[] | null {
        if (!this.branches) return null;
        if (!isNamedBranch(name)) return null;
        return this.branches[name];
    }
    /**
     * Return the atoms in the branch, if it exists, otherwise create it
     */
    createBranch(name: Branch): Atom[] {
        console.assert(isNamedBranch(name));
        if (!isNamedBranch(name)) return [];
        if (!this.branches) {
            this.branches = {
                [name]: [this.makeFirstAtom(name)],
            };
        } else if (!this.branches[name]) {
            this.branches[name] = [this.makeFirstAtom(name)];
        }
        this.isDirty = true;
        return this.branches[name];
    }
    get row(): number {
        if (!isColRowBranch(this.treeBranch)) return -1;
        return this.treeBranch[0];
    }
    get col(): number {
        if (!isColRowBranch(this.treeBranch)) return -1;
        return this.treeBranch[1];
    }
    get body(): Atom[] {
        return this.branches?.body;
    }
    set body(atoms: Atom[]) {
        this.setChildren(atoms, 'body');
    }
    get superscript(): Atom[] {
        return this.branches?.superscript;
    }
    set superscript(atoms: Atom[]) {
        this.setChildren(atoms, 'superscript');
    }
    get subscript(): Atom[] {
        return this.branches?.subscript;
    }
    set subscript(atoms: Atom[]) {
        this.setChildren(atoms, 'subscript');
    }
    get above(): Atom[] {
        return this.branches?.above;
    }
    set above(atoms: Atom[]) {
        this.setChildren(atoms, 'above');
    }
    get below(): Atom[] {
        return this.branches?.below;
    }
    set below(atoms: Atom[]) {
        this.setChildren(atoms, 'below');
    }
    get computedStyle(): Style {
        if (!this.parent) return this.style ?? {};
        return { ...this.parent.computedStyle, ...this.style };
    }
    applyStyle(style: Style): void {
        this.style = { ...this.style, ...style };

        if (this.style.fontFamily === 'none') {
            delete this.style.fontFamily;
        }
        if (this.style.fontShape === 'auto') {
            delete this.style.fontShape;
        }
        if (this.style.fontSeries === 'auto') {
            delete this.style.fontSeries;
        }
        if (this.style.color === 'none') {
            delete this.style.color;
        }
        if (this.style.backgroundColor === 'none') {
            delete this.style.backgroundColor;
        }
        if (this.style.fontSize === 'auto') {
            delete this.style.fontSize;
        }

        if (this.style.fontSize) {
            this.maxFontSize = SIZING_MULTIPLIER[this.style.fontSize];
        }
    }

    getInitialBaseElement(): Atom {
        let result: Atom;
        if (!this.hasEmptyBranch('body')) {
            console.assert(this.body[0].type === 'first');
            result = this.body[1].getInitialBaseElement();
        }
        return result ?? this;
    }

    getFinalBaseElement(): Atom {
        if (!this.hasEmptyBranch('body')) {
            return this.body[this.body.length - 1].getFinalBaseElement();
        }
        return this;
    }

    isCharacterBox(): boolean {
        const base = this.getInitialBaseElement();
        return /minner|mbin|mrel|mpunct|mopen|mclose|textord/.test(base.type);
    }

    hasEmptyBranch(branch: Branch): boolean {
        const atoms = this.branch(branch);
        if (!atoms) return true;
        console.assert(atoms.length > 0);
        console.assert(atoms[0].type === 'first');
        return atoms.length === 1;
    }
    /*
     * Setting `null` does nothing
     * Setting `[]` adds an empty list (the branch is created)
     * The children should *not* start with a `'first'` atom:
     * the `first` atom will be added if necessary
     */
    setChildren(children: Atom[], branch: Branch): void {
        if (!children) return;
        console.assert(isNamedBranch(branch));
        if (!isNamedBranch(branch)) return;
        console.assert(children[0]?.type !== 'first');

        // Update the parent
        if (!this.branches) {
            this.branches = {
                [branch]: [this.makeFirstAtom(branch), ...children],
            };
        } else {
            this.branches[branch] = [this.makeFirstAtom(branch), ...children];
        }
        this.isDirty = true;

        // Update the children
        children.forEach((x) => {
            x.parent = this;
            x.treeBranch = branch;
        });
    }
    makeFirstAtom(branch: Branch): Atom {
        const result = new Atom('first', { mode: this.mode });
        result.parent = this;
        result.treeBranch = branch;
        return result;
    }

    addChild(child: Atom, branch: Branch): void {
        console.assert(child.type !== 'first');

        this.createBranch(branch).push(child);
        this.isDirty = true;

        // Update the child
        child.parent = this;
        child.treeBranch = branch;
    }

    addChildBefore(child: Atom, before: Atom): void {
        const branch = this.createBranch(before.treeBranch);
        branch.splice(branch.indexOf(before), 0, child);
        this.isDirty = true;

        // Update the child
        child.parent = this;
        child.treeBranch = before.treeBranch;
    }
    addChildAfter(child: Atom, after: Atom): void {
        const branch = this.createBranch(after.treeBranch);
        branch.splice(branch.indexOf(after) + 1, 0, child);
        this.isDirty = true;

        // Update the child
        child.parent = this;
        child.treeBranch = after.treeBranch;
    }
    addChildren(children: Atom[], branch: Branch): void {
        children.forEach((x) => this.addChild(x, branch));
    }
    addChildrenAfter(children: Atom[], after: Atom): void {
        console.assert(children.length === 0 || children[0].type !== 'first');
        const branch = this.createBranch(after.treeBranch);
        branch.splice(branch.indexOf(after) + 1, 0, ...children);
        this.isDirty = true;

        // Update the children
        children.forEach((x) => {
            x.parent = this;
            x.treeBranch = after.treeBranch;
        });
    }
    removeBranch(name: Branch): Atom[] {
        const children = this.branch(name);
        if (isNamedBranch(name)) {
            this.branches[name] = null;
        }
        children.forEach((x) => {
            x.parent = null;
            x.treeBranch = undefined;
        });
        // Drop the 'first' element
        console.assert(children[0].type === 'first');
        children.shift();
        this.isDirty = true;
        return children;
    }
    removeChild(child: Atom): void {
        console.assert(child.parent === this);

        // `first` atom cannot be deleted
        if (child.type === 'first') return;

        // Update the parent
        const branch = this.branch(child.treeBranch);
        const index = branch.indexOf(child);
        console.assert(index >= 0);
        branch.splice(index, 1);
        this.isDirty = true;

        // Update the child
        child.parent = null;
        child.treeBranch = undefined;
    }
    get siblings(): Atom[] {
        if (this.type === 'root') return [];
        return this.parent.branch(this.treeBranch);
    }
    get firstSibling(): Atom {
        return this.siblings[0];
    }
    get lastSibling(): Atom {
        const siblings = this.siblings;
        return siblings[siblings.length - 1];
    }
    get isFirstSibling(): boolean {
        return this === this.firstSibling;
    }
    get isLastSibling(): boolean {
        return this === this.lastSibling;
    }
    get hasNoSiblings(): boolean {
        return this.siblings.length === 1;
    }
    get leftSibling(): Atom {
        const siblings = this.parent.branch(this.treeBranch);
        return siblings[siblings.indexOf(this) - 1];
    }
    get rightSibling(): Atom {
        const siblings = this.parent.branch(this.treeBranch);
        return siblings[siblings.indexOf(this) + 1];
    }

    get hasChildren(): boolean {
        // @todo array: account for colRow branches
        return this.branches && this.children.length > 0;
    }
    get firstChild(): Atom {
        console.assert(this.hasChildren);
        return this.children[0];
    }
    get lastChild(): Atom {
        console.assert(this.hasChildren);
        const children = this.children;
        return children[children.length - 1];
    }

    /**
     * All the children of this atom.
     *
     * The order of the atoms is the order in which they
     * are navigated using the keyboard.
     */
    get children(): Atom[] {
        if (this._children) return this._children;
        // @todo array: add colrow branches
        const result = [];
        if (this.branches) {
            NAMED_BRANCHES.forEach((branch) => {
                if (this.branches[branch]) {
                    this.branches[branch].forEach((x) => {
                        result.push(...x.children);
                        result.push(x);
                    });
                }
            });
        }
        this._children = result;
        return result;
    }

    /**
     * The common ancestor between two atoms
     */
    static commonAncestor(a: Atom, b: Atom): Atom {
        if (a === b) return a.parent;

        // Short-circuit a common case
        if (a.parent === b.parent) return a.parent;

        // Accumulate all the parents of `a`
        const parents = new WeakSet<Atom>();
        let parent = a.parent;
        while (parent) {
            parents.add(parent);
            parent = parent.parent;
        }
        // Walk up the parents of `b`. If a parent of `b` is also a parent of
        // `a`, it's the common ancestor
        parent = b.parent;
        while (parent) {
            if (parents.has(parent)) return parent;
            parent = parent.parent;
        }
        console.assert(!!parent); // Never reached
        return null;
    }

    /**
     * Render this atom as an array of Spans
     *
     * @param context Font variant, size, color, etc...
     */
    render(context: Context): Span[] | null {
        // Render the body branch if present, even if it's empty (need to
        // render the 'first' atom to render the caret in an empty branch
        let result: Span = this.makeSpan(context, this.body ?? this.value);
        if (!result) return null;

        result.type = isSpanType(this.type) ? this.type : '';

        if (this.containsCaret) {
            result.classes = (result.classes || '') + ' ML__contains-caret';
        }
        // Finally, render any necessary superscript, subscripts
        if (!this.limits && (this.superscript || this.subscript)) {
            // If `limits` is set, the attachment of sup/sub was handled
            // in the atom decomposition (e.g. mop, accent)
            result = this.attachSupsub(context, result, result.type);
        }
        return [result];
    }

    attachSupsub(context: Context, nucleus: Span, type: SpanType): Span {
        // If no superscript or subscript, nothing to do.
        if (!this.superscript && !this.subscript) {
            return nucleus;
        }
        // Superscript and subscripts are discussed in the TeXbook
        // on page 445-446, rules 18(a-f).
        // TeX:14859-14945
        const mathstyle = context.mathstyle;
        let supmid = null;
        let submid = null;
        if (this.branches.superscript) {
            const sup = Atom.render(context.sup(), this.branches.superscript);
            supmid = makeSpan(sup, mathstyle.adjustTo(mathstyle.sup()));
        }
        if (this.branches.subscript) {
            const sub = Atom.render(context.sub(), this.branches.subscript);
            submid = makeSpan(sub, mathstyle.adjustTo(mathstyle.sub()));
        }
        // Rule 18a, p445
        let supShift = 0;
        let subShift = 0;
        if (!this.isCharacterBox()) {
            supShift = spanHeight(nucleus) - mathstyle.metrics.supDrop;
            subShift = spanDepth(nucleus) + mathstyle.metrics.subDrop;
        }
        // Rule 18c, p445
        let minSupShift: number;
        if (mathstyle === MATHSTYLES.displaystyle) {
            minSupShift = mathstyle.metrics.sup1; // sigma13
        } else if (mathstyle.cramped) {
            minSupShift = mathstyle.metrics.sup3; // sigma15
        } else {
            minSupShift = mathstyle.metrics.sup2; // sigma14
        }
        // scriptspace is a font-size-independent size, so scale it
        // appropriately @revisit: do we really need to do this scaling? It's in em...
        const multiplier =
            MATHSTYLES.textstyle.sizeMultiplier * mathstyle.sizeMultiplier;
        const scriptspace = 0.5 / FONTMETRICS.ptPerEm / multiplier;
        let supsub: Span | null = null;
        if (submid && supmid) {
            // Rule 18e
            supShift = Math.max(
                supShift,
                minSupShift,
                supmid.depth + 0.25 * mathstyle.metrics.xHeight
            );
            subShift = Math.max(subShift, mathstyle.metrics.sub2);
            const ruleWidth = FONTMETRICS.defaultRuleThickness;
            if (
                supShift - spanDepth(supmid) - (spanHeight(submid) - subShift) <
                4 * ruleWidth
            ) {
                subShift =
                    4 * ruleWidth -
                    (supShift - supmid.depth) +
                    spanHeight(submid);
                const psi =
                    0.8 * mathstyle.metrics.xHeight -
                    (supShift - spanDepth(supmid));
                if (psi > 0) {
                    supShift += psi;
                    subShift -= psi;
                }
            }
            supsub = makeVlist(
                context,
                [submid, subShift, supmid, -supShift],
                'individualShift'
            );
            // Subscripts shouldn't be shifted by the nucleus' italic correction.
            // Account for that by shifting the subscript back the appropriate
            // amount. Note we only do this when the nucleus is a single symbol.
            if (this.isExtensibleSymbol) {
                supsub.children[0].left = -spanItalic(nucleus);
            }
        } else if (submid && !supmid) {
            // Rule 18b
            subShift = Math.max(
                subShift,
                mathstyle.metrics.sub1,
                spanHeight(submid) - 0.8 * mathstyle.metrics.xHeight
            );
            supsub = makeVlist(context, [submid], 'shift', subShift);
            supsub.children[0].right = scriptspace;
            if (this.isCharacterBox()) {
                supsub.children[0].left = -spanItalic(nucleus);
            }
        } else if (!submid && supmid) {
            // Rule 18c, d
            supShift = Math.max(
                supShift,
                minSupShift,
                supmid.depth + 0.25 * mathstyle.metrics.xHeight
            );
            supsub = makeVlist(context, [supmid], 'shift', -supShift);
            supsub.children[0].right = scriptspace;
        }
        // Display the caret *following* the superscript and subscript,
        // so attach the caret to the 'msubsup' element.
        const supsubContainer = makeSpan(supsub, 'msubsup');
        if (this.caret) {
            supsubContainer.caret = this.caret;
            // this.caret = ''; // @revisit: we shouln't clear the **Atom** caret
        }
        return makeSpan([nucleus, supsubContainer], '', type);
    }

    attachLimits(
        context: Context,
        nucleus: Span,
        nucleusShift: number,
        slant: number
    ): Span {
        const limitAbove = this.superscript
            ? makeSpan(
                  Atom.render(context.sup(), this.superscript),
                  context.mathstyle.adjustTo(context.mathstyle.sup())
              )
            : null;
        const limitBelow = this.subscript
            ? makeSpan(
                  Atom.render(context.sub(), this.subscript),
                  context.mathstyle.adjustTo(context.mathstyle.sub())
              )
            : null;
        return makeLimitsStack(
            context,
            nucleus,
            nucleusShift,
            slant,
            limitAbove,
            limitBelow
        );
    }

    /**
     * Add an ID attribute to both the span and this atom so that the atom
     * can be retrieved from the span later on (e.g. when the span is clicked on)
     */
    bind(context: Context, span: Span): Span {
        if (this.type !== 'first' && this.value !== '\u200b') {
            this.id = makeID(context);
            if (this.id) {
                if (!span.attributes) span.attributes = {};
                span.attributes['data-atom-id'] = this.id;
            }
        }
        return span;
    }

    /**
     * Create a span with the specified body and with a class attribute
     * equal to the type ('mbin', 'inner', 'spacing', etc...)
     *
     */
    makeSpan(context: Context, value: string | Atom[]): Span {
        // Ensure that the atom type is a valid Span type, or use ''
        const type: SpanType =
            this.type === 'textord'
                ? 'mord'
                : isSpanType(this.type)
                ? this.type
                : '';
        const result = makeSpan(
            typeof value === 'string' ? value : Atom.render(context, value),
            '',
            type
        );

        // The font family is determined by:
        // - the base font family associated with this atom (optional). For example,
        // some atoms such as some functions ('\sin', '\cos', etc...) or some
        // symbols ('\Z') have an explicit font family. This overrides any
        // other font family
        // - the user-specified font family that has been explicitly applied to
        // this atom
        // - the font family automatically determined in math mode, for example
        // which italicizes some characters, but which can be overridden

        const style: Style = {
            variant: 'normal', // will auto-italicize
            ...this.style,
            letterShapeStyle: context.letterShapeStyle,
        };
        result.applyStyle(this.mode, style);

        // Apply size correction
        const size = style?.fontSize ? style.fontSize : 'size5';
        if (size !== context.parentSize) {
            result.classes += ' sizing reset-' + context.parentSize;
            result.classes += ' ' + size;
        } else if (context.parentSize !== context.size) {
            result.classes += ' sizing reset-' + context.parentSize;
            result.classes += ' ' + context.size;
        }
        result.maxFontSize = Math.max(
            result.maxFontSize,
            context.mathstyle.sizeMultiplier ?? 1.0
        );

        // Set other attributes

        if (this.mode === 'text') result.classes += ' ML__text';
        if (context.mathstyle.isTight()) result.isTight = true;
        // The italic correction applies only in math mode
        if (this.mode !== 'math') result.italic = 0;
        result.right = result.italic; // Italic correction

        if (typeof context.opacity === 'number') {
            result.setStyle('opacity', context.opacity);
        }

        // To retrieve the atom from a span, for example when the span is clicked
        // on, attach a randomly generated ID to the span and associate it
        // with the atom.
        this.bind(context, result);
        if (this.caret) {
            // If this has a super/subscript, the caret will be attached
            // to the 'msubsup' atom, so no need to have it here.
            if (!this.superscript && !this.subscript) {
                result.caret = this.caret;
                // this.caret = ''; // @revisit: we shouln't clear the **Atom** caret
            }
        }
        if (context.mathstyle.isTight()) result.isTight = true;
        return result;
    }
}

function makeID(context: Context): string {
    let result: string;
    if (context.atomIdsSettings) {
        if (typeof context.atomIdsSettings.seed === 'number') {
            result = context.atomIdsSettings.overrideID
                ? context.atomIdsSettings.overrideID
                : context.atomIdsSettings.seed.toString(36);
            context.atomIdsSettings.seed += 1;
        } else {
            result =
                Date.now().toString(36).slice(-2) +
                Math.floor(Math.random() * 0x186a0).toString(36);
        }
    }
    return result;
}

/* Combine a nucleus with an atom above and an atom below. Used to form
 * limits.
 *
 * @param context
 * @param nucleus The base over and under which the atoms will
 * be placed.
 * @param nucleusShift The vertical shift of the nucleus from
 * the baseline.
 * @param slant For operators that have a slant, such as \int,
 * indicate by how much to horizontally offset the above and below atoms
 */
function makeLimitsStack(
    context: Context,
    nucleus: Span,
    nucleusShift: number,
    slant: number,
    above: Span,
    below: Span
): Span {
    // If nothing above and nothing below, nothing to do.
    if (!above && !below) return nucleus;

    // IE8 clips \int if it is in a display: inline-block. We wrap it
    // in a new span so it is an inline, and works.
    // @todo: revisit
    nucleus = makeSpan(nucleus);

    let aboveShift = 0;
    let belowShift = 0;

    if (above) {
        aboveShift = Math.max(
            FONTMETRICS.bigOpSpacing1,
            FONTMETRICS.bigOpSpacing3 - spanDepth(above)
        );
    }
    if (below) {
        belowShift = Math.max(
            FONTMETRICS.bigOpSpacing2,
            FONTMETRICS.bigOpSpacing4 - spanHeight(below)
        );
    }

    let result: Span | null = null;

    if (below && above) {
        const bottom =
            FONTMETRICS.bigOpSpacing5 +
            spanHeight(below) +
            spanDepth(below) +
            belowShift +
            spanDepth(nucleus) +
            nucleusShift;

        result = makeVlist(
            context,
            [
                FONTMETRICS.bigOpSpacing5,
                below,
                belowShift,
                nucleus,
                aboveShift,
                above,
                FONTMETRICS.bigOpSpacing5,
            ],
            'bottom',
            bottom
        );

        // Here, we shift the limits by the slant of the symbol. Note
        // that we are supposed to shift the limits by 1/2 of the slant,
        // but since we are centering the limits adding a full slant of
        // margin will shift by 1/2 that.
        result!.children[0].left = -slant;
        result!.children[2].left = slant;
    } else if (below && !above) {
        const top = spanHeight(nucleus) - nucleusShift;

        result = makeVlist(
            context,
            [FONTMETRICS.bigOpSpacing5, below, belowShift, nucleus],
            'top',
            top
        );

        // See comment above about slants
        result!.children[0].left = -slant;
    } else if (!below && above) {
        const bottom = spanDepth(nucleus) + nucleusShift;

        result = makeVlist(
            context,
            [nucleus, aboveShift, above, FONTMETRICS.bigOpSpacing5],
            'bottom',
            bottom
        );

        // See comment above about slants
        result!.children[1].left = slant;
    }

    return makeSpan(result, 'op-limits', 'mop');
}

/**
 *
 * @param atoms the list of atoms to emit as LaTeX
 * @param options.expandMacro true if macros should be expanded
 * @result a LaTeX string
 */
function atomsToLatex(atoms: Atom[], options: ToLatexOptions): string {
    if (atoms[0].type === 'first') {
        if (atoms.length === 1) return '';
        // Remove the 'first' atom, if present
        atoms = atoms.slice(1);
    }
    if (atoms.length === 0) return '';

    return joinLatex(
        getPropertyRuns(atoms, 'cssClass').map((x) =>
            joinLatex(
                getPropertyRuns(x, 'color').map((x) =>
                    joinLatex(
                        getModeRuns(x).map((x) => emitLatexRun(x, options))
                    )
                )
            )
        )
    );
}
