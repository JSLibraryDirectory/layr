import {inspect} from 'util';
import {FieldMask, callWithOneOrMany, findFromOneOrMany} from '@storable/util';
import isEmpty from 'lodash/isEmpty';

import {Field} from './field';

export class Model {
  static create(object, {previousInstance, deserialize, ...otherOptions} = {}) {
    if (deserialize) {
      const existingInstance = this._findExistingInstance(object, {previousInstance});
      if (existingInstance) {
        existingInstance._initialize(object, {deserialize, ...otherOptions});
        return existingInstance;
      }
    }

    return new this(object, {deserialize, ...otherOptions});
  }

  constructor(object, options) {
    this._activeFields = new Set();
    this._fieldValues = {};
    this._fieldSources = {};
    this._savedFieldValues = {};

    this._initialize(object, options);
  }

  _initialize(object = {}, {fields, deserialize, source} = {}) {
    if (typeof object !== 'object') {
      throw new Error(
        `Type mismatch (model: '${this.constructor.getName()}', expected: 'object', provided: '${typeof object}')`
      );
    }

    const rootFields = fields !== undefined ? new FieldMask(fields) : undefined;

    const isNew = deserialize ? Boolean(object._new) : true;

    this.constructor.forEachField(field => {
      let fields;
      if (rootFields) {
        fields = rootFields.get(field.name);
        if (!fields) {
          return;
        }
      } else if (
        !(
          isNew ||
          Object.prototype.hasOwnProperty.call(object, field.name) ||
          object._undefined?.includes(field.name)
        )
      ) {
        return;
      }

      const value = object[field.name];
      this._setFieldValue(field, value, {fields, deserialize, source});
      if (isNew && value === undefined) {
        this._applyFieldDefault(field);
      }
    });

    if (isNew) {
      this.markAsNew();
    }
  }

  assign(object) {
    if (object === undefined) {
      // NOOP
    } else if (object.isOfType && object.isOfType('Model')) {
      this._assignOther(object);
    } else {
      this._assignObject(object);
    }
  }

  _assignObject(object) {
    for (const [name, value] of Object.entries(object)) {
      const field = this.constructor.getField(name, {throwIfNotFound: false});
      if (field) {
        this._setFieldValue(field, value);
      }
    }
  }

  _assignOther(other) {
    other.forEachField(otherField => {
      const field = this.constructor.getField(otherField.name, {throwIfNotFound: false});
      if (field) {
        const value = other._getFieldValue(otherField);
        this._setFieldValue(field, value);
      }
    });
  }

  clone() {
    return this.constructor.deserialize(this.serialize());
  }

  // === Serialization ===

  serialize({target, filter, _isDeep, ...otherOptions} = {}) {
    if (!_isDeep) {
      this.validate({filter});
    }

    const isNew = this.isNew();
    const definedFields = {};
    let undefinedFields;

    this.forEachField(
      field => {
        if (target !== undefined) {
          const source = this._getFieldSource(field);
          if (target === source) {
            return;
          }
        }

        let value = this._getFieldValue(field);

        value = field.serializeValue(value, {
          target,
          filter,
          ...otherOptions,
          _isDeep: true
        });

        if (value !== undefined) {
          definedFields[field.name] = value;
        } else {
          if (!undefinedFields) {
            undefinedFields = [];
          }
          undefinedFields.push(field.name);
        }
      },
      {filter}
    );

    return {
      ...(isNew && {_new: true}),
      _type: this.constructor.getName(),
      ...definedFields,
      ...(undefinedFields && {_undefined: undefinedFields})
    };
  }

  toJSON() {
    return this.serialize();
  }

  static deserialize(object, options) {
    return this.create(object, {...options, deserialize: true});
  }

  deserialize(object, options) {
    return this.constructor.deserialize(object, {...options, previousInstance: this});
  }

  static _findExistingInstance(object, {previousInstance}) {
    if (
      previousInstance !== undefined &&
      !Array.isArray(previousInstance) &&
      previousInstance.constructor === this
    ) {
      return previousInstance;
    }
  }

  // === Core ===

  static defineField(name, type, options, descriptor) {
    if (descriptor.initializer) {
      options = {...options, default: descriptor.initializer};
    }

    const field = this.setField(name, type, options);

    descriptor.get = function () {
      return this._getFieldValue(field);
    };
    descriptor.set = function (val) {
      return this._setFieldValue(field, val);
    };

    delete descriptor.initializer;
    delete descriptor.writable;
  }

  static getField(name, {throwIfNotFound = true} = {}) {
    const field = this._fields?.[name];
    if (field) {
      return field;
    }
    if (throwIfNotFound) {
      throw new Error(`Field not found (name: '${name}'), model: ${this.getName()}`);
    }
  }

  getField(name, {throwIfNotFound = true} = {}) {
    const field = this.constructor.getField(name, {throwIfNotFound});
    if (field) {
      if (this.fieldIsActive(field)) {
        return field;
      }
      if (throwIfNotFound) {
        throw new Error(`Field not active (name: '${name}'), model: ${this.getName()}`);
      }
    }
  }

  static setField(name, type, options) {
    if (!Object.prototype.hasOwnProperty.call(this, '_fields')) {
      this._fields = {...this._fields};
    }
    let field = this._fields[name];
    if (field) {
      throw new Error(`Field already exists (name: '${name}')`);
    }
    field = new Field(name, type, options);
    this._fields[name] = field;
    return field;
  }

  activateField(field) {
    this._activeFields.add(field.name);
  }

  fieldIsActive(field) {
    return this._activeFields.has(field.name);
  }

  fieldsAreActive(fields) {
    const rootFields = new FieldMask(fields);

    const result = this.constructor.forEachField(field => {
      const fields = rootFields.get(field.name);
      if (!fields) {
        return;
      }

      if (!this.fieldIsActive(field)) {
        return false;
      }

      const value = this._getFieldValue(field);
      if (value !== undefined) {
        const incompleteValue = findFromOneOrMany(value, value => {
          if (this.constructor.fieldValueIsSubmodel(value)) {
            return !value.fieldsAreActive(fields);
          }
        });
        if (incompleteValue !== undefined) {
          return false;
        }
      }
    });

    return result !== false;
  }

  static filterEntityFields(fields) {
    fields = new FieldMask(fields);
    fields = this._filterEntityFields(fields);
    return new FieldMask(fields);
  }

  static _filterEntityFields(rootFields) {
    const filteredFields = {};

    this.forEachField(field => {
      const fields = rootFields.get(field.name);
      if (!fields) {
        return;
      }

      if (field.scalar.isPrimitiveType()) {
        filteredFields[field.name] = true;
        return;
      }

      const Model = field.scalar.getModel(this._getRegistry());

      if (Model.prototype.isOfType('EntityModel')) {
        filteredFields[field.name] = {};
        return;
      }

      filteredFields[field.name] = Model._filterEntityFields(fields);
    });

    return filteredFields;
  }

  static forEachField(func) {
    if (this._fields) {
      for (const field of Object.values(this._fields)) {
        const result = func(field);
        if (result !== undefined) {
          // Early return if the function returned something
          return result;
        }
      }
    }
  }

  forEachField(func, {filter} = {}) {
    return this.constructor.forEachField(field => {
      if (this.fieldIsActive(field)) {
        if (filter && !filter(this, field)) {
          return;
        }
        return func(field);
      }
    });
  }

  static fieldValueIsSubmodel(value) {
    return value?.isOfType && !value.isOfType('EntityModel');
  }

  static fieldValueIsNestedEntity(value) {
    return value?.isOfType && value.isOfType('EntityModel');
  }

  forEachSubmodel(func) {
    return this.forEachField(field => {
      const value = this._getFieldValue(field);
      return callWithOneOrMany(value, value => {
        if (this.constructor.fieldValueIsSubmodel(value)) {
          return func(value);
        }
      });
    });
  }

  forEachNestedEntityDeep(func, {fields} = {}) {
    const rootFields = new FieldMask(fields);

    return this.constructor.forEachField(field => {
      const fields = rootFields.get(field.name);
      if (!fields) {
        return;
      }

      const value = this._getFieldValue(field);
      if (value !== undefined) {
        return callWithOneOrMany(value, value => {
          if (this.constructor.fieldValueIsNestedEntity(value)) {
            const result = func(value, {fields});
            if (result !== undefined) {
              return result;
            }
          }

          if (value?.isOfType && value.isOfType('Model')) {
            return value.forEachNestedEntityDeep(func, {fields});
          }
        });
      }
    });
  }

  _getFieldValue(field) {
    let value = this._fieldValues[field.name];
    if (value === undefined && field.isArray) {
      value = [];
      this._fieldValues[field.name] = value;
    }
    return value;
  }

  _setFieldValue(field, value, {fields, deserialize, source} = {}) {
    if (!deserialize) {
      this._saveFieldValue(field);
    }
    const previousValue = this._fieldValues[field.name];
    const registry = this.constructor._getRegistry({throwIfNotFound: false});
    value = field.createValue(value, {previousValue, registry, fields, deserialize, source});
    this._fieldValues[field.name] = value;
    this._setFieldSource(field, source !== undefined ? source : registry);
    this.activateField(field);
    return value;
  }

  getFieldSource(name) {
    return this._getFieldSource(this.getField(name));
  }

  _getFieldSource(field) {
    return this._fieldSources[field.name];
  }

  setFieldSource(name, source) {
    return this._setFieldSource(this.getField(name), source);
  }

  _setFieldSource(field, source) {
    this._fieldSources[field.name] = source;
  }

  _applyFieldDefault(field) {
    let value = field.default;
    while (typeof value === 'function') {
      value = value.call(this);
    }
    if (value !== undefined) {
      this._setFieldValue(field, value);
    }
  }

  _saveFieldValue(field) {
    this._savedFieldValues[field.name] = this._fieldValues[field.name];
  }

  commit() {
    this._savedFieldValues = {};

    this.forEachSubmodel(submodel => {
      submodel.commit();
    });
  }

  rollback() {
    for (const [name, value] of Object.entries(this._savedFieldValues)) {
      this._fieldValues[name] = value;
    }
    this._savedFieldValues = {};

    this.forEachSubmodel(submodel => {
      submodel.rollback();
    });
  }

  isChanged() {
    return this._isChanged() === true;
  }

  _isChanged() {
    if (!isEmpty(this._savedFieldValues)) {
      return true;
    }

    return this.forEachSubmodel(submodel => submodel._isChanged());
  }

  fieldIsChanged(field) {
    if (Object.prototype.hasOwnProperty.call(this._savedFieldValues, field.name)) {
      return true;
    }

    const value = this._getFieldValue(field);
    if (value !== undefined) {
      const changedValue = findFromOneOrMany(value, value => {
        if (this.constructor.fieldValueIsSubmodel(value)) {
          return value.isChanged();
        }
      });
      if (changedValue !== undefined) {
        return true;
      }
    }

    return false;
  }

  isNew() {
    return this._new === true;
  }

  markAsNew() {
    this._new = true;
  }

  markAsNotNew() {
    this._new = false;
  }

  static _getRegistry({throwIfNotFound = true} = {}) {
    if (!this.$registry && throwIfNotFound) {
      throw new Error(`Registry not found (model: ${this.getName()})`);
    }
    return this.$registry;
  }

  // === Validation ===

  validate({filter} = {}) {
    const failedValidators = this.getFailedValidators({filter});
    if (failedValidators) {
      const error = new Error(
        `Model validation failed (model: '${this.constructor.getName()}', failedValidators: ${JSON.stringify(
          failedValidators
        )})`
      );
      error.failedValidators = failedValidators;
      throw error;
    }
  }

  isValid({filter} = {}) {
    return this.getFailedValidators({filter}) === undefined;
  }

  getFailedValidators({filter} = {}) {
    let result;
    this.forEachField(
      field => {
        const value = this._getFieldValue(field);
        const failedValidators = field.validateValue(value, {filter});
        if (!isEmpty(failedValidators)) {
          if (!result) {
            result = {};
          }
          result[field.name] = failedValidators;
        }
      },
      {filter}
    );
    return result;
  }

  // === Remote invocation ===

  static remoteRegistry = 'remoteRegistry';

  static defineRemoteMethod(name, descriptor) {
    descriptor.value = async function (...args) {
      return this.callRemote(name, ...args);
    };
    delete descriptor.initializer;
    delete descriptor.writable;
  }

  static async callRemote(methodName, ...args) {
    const registry = this._getRegistry();
    const remoteRegistry = this._getRemoteRegistry();
    const query = {
      [`${this.getName()}=>`]: {
        [`${methodName}=>result`]: {
          '([])': args
        }
      }
    };
    const {result} = await remoteRegistry.invokeQuery(query, {source: registry});
    return result;
  }

  async callRemote(methodName, ...args) {
    const registry = this.constructor._getRegistry();
    const remoteRegistry = this.constructor._getRemoteRegistry();
    const query = {
      '<=': this,
      [`${methodName}=>result`]: {
        '([])': args
      },
      '=>changes': true
    };
    const {result} = await remoteRegistry.invokeQuery(query, {source: registry});
    return result;
  }

  static _getRemoteRegistry() {
    const registry = this._getRegistry();
    const remoteRegistry = registry[this.remoteRegistry];
    if (!remoteRegistry) {
      throw new Error(
        `Remote registry not found (model: ${this.name}, remoteRegistry: ${this.remoteRegistry})`
      );
    }
    return remoteRegistry;
  }

  // === Utilities ===

  static getName() {
    return this.name;
  }

  [inspect.custom]() {
    const object = {};
    this.forEachField(field => {
      const value = this._getFieldValue(field);
      if (value !== undefined) {
        object[field.name] = value;
      }
    });
    return object;
  }

  isOfType(name) {
    if (name === 'Model') {
      return true; // Optimization
    }

    let Model = this.constructor;
    while (Model) {
      if (Model.name === name) {
        return true;
      }
      Model = Object.getPrototypeOf(Model);
    }
    return false;
  }
}

// === Decorators ===

export function field(type, options) {
  return function (target, name, descriptor) {
    target.constructor.defineField(name, type, options, descriptor);
  };
}

export function remoteMethod() {
  return function (target, name, descriptor) {
    if (!(typeof target === 'function')) {
      // The target is the prototype
      target = target.constructor;
    }
    target.defineRemoteMethod(name, descriptor);
  };
}
