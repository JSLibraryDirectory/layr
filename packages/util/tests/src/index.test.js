import {mapFromOneOrMany, findFromOneOrMany} from '../../..';

describe('@superstore/util', () => {
  test('mapFromOneOrMany()', () => {
    const result = mapFromOneOrMany('aaa', value => value.toUpperCase());
    expect(result).toBe('AAA');

    const results = mapFromOneOrMany(['aaa', 'bbb', 'ccc'], value => value.toUpperCase());
    expect(results).toEqual(['AAA', 'BBB', 'CCC']);
  });

  test('findFromOneOrMany()', () => {
    let result = findFromOneOrMany('aaa', value => value === 'aaa');
    expect(result).toBe('aaa');

    result = findFromOneOrMany('zzz', value => value === 'aaa');
    expect(result).toBeUndefined();

    result = findFromOneOrMany(['aaa', 'bbb', 'ccc'], value => value === 'bbb');
    expect(result).toEqual('bbb');

    result = findFromOneOrMany(['aaa', 'zzz', 'ccc'], value => value === 'bbb');
    expect(result).toBeUndefined();
  });
});
