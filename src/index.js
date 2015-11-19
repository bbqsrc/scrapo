'use strict';

const TAG = 'scrapo';

var request = require('superagent'),
    http = require('http'),
    cheerio = require('cheerio'),
    co = require('co'),
    mongodb = require('mongodb'),
    Log = require('huggare-log');

let db;

class Page {
  constructor(res) {
    this.res = res;
    this.$ = cheerio.load(res.text);
  }

  get url() {
    return this.res.request.url;
  }

  get data() {
    if (this._scraped) {
      return this._scraped;
    }

    return this._scraped = this.scrape();
  }

  getFieldName(fuzzyName) {
    return this.$("[name*='" + fuzzyName + "']").attr('name');
  }

  postForm(formData) {
    return request.agent(http.globalAgent).post(this.url).redirects().type('form').send(formData);
  }

  getFormData() {
    let i, ii, option, name, type,
        formNode = this.$.root(),
        node, nodes,
        o = {};

    nodes = formNode.find('input[name]');
    for (i = 0, ii = nodes.length; i < ii; ++i) {
      node = this.$(nodes[i]);
      name = node.attr('name');
      type = node.attr('type');

      if (type == 'submit') {
        continue;
      }

      if (type == 'checkbox') {
        o[name] = node.attr('checked') != null ? 'on' : '';
      } else if (type == 'radio' && node.attr('checked')) {
        o[name] = node.attr('value');
      } else {
        o[name] = node.attr('value') || '';
      }
    }

    nodes = formNode.find('textarea[name]');
    for (i = 0, ii = nodes.length; i < ii; ++i) {
      node = this.$(nodes[i]);
      name = node.attr('name');
      o[name] = node.text() || '';
    }

    nodes = formNode.find('select[name]');
    for (i = 0, ii = nodes.length; i < ii; ++i) {
      node = this.$(nodes[i]);
      name = node.attr('name');
      option = node.find('option[selected]');
      if (!option.length) {
        option = node.find('option').first();
      }
      o[name] = option.attr('value') || '';
    }

    return o;
  }
}

class TitlePage extends Page {
  scrapeTable() {
    let $ = this.$;
    let o = {};

    let rows = [].slice.call($('.ncd-view-item tr'));
    for (let row of rows) {
      row = $(row);

      let title = row.find('.ncd-field-title');
      let value = row.find('.ncd-field-value');

      if (!title.length || !value.length) {
        continue;
      }

      let titleText = title.text().trim();
      let valueText = value.text().trim();

      if (titleText === 'Country of Origin') {
        valueText = valueText.split('|');
      }

      o[titleText] = valueText;
    }

    return o;
  }

  scrapeMatrix() {
    let $ = this.$;
    let o = {};

    let matrix = $('.ncd-matrix');

    if (!matrix.length) {
      return;
    }

    let impacts = matrix.find('.ncd-matrix-impact').map(function() {
      return $(this).text().trim();
    });

    $('.ncd-matrix .ncd-matrix-row').slice(1).each(function() {
      let c = $(this).children();
      let name = c.first().text().trim();
      let selected = c.filter('.selected').index();

      if (selected > -1) {
        o[name] = impacts[selected-1];
      }
    });

    return o;
  }

  scrapeRC() {
    let rc = this.$('.ncd-rc-container');

    if (!rc.length) {
      return;
    }

    return {
      title: rc.find('.ncd-rc-title').text().trim(),
      detail: rc.find('.ncd-rc-detail').text().trim()
    };
  }

  scrape() {
    let $ = this.$;

    let o = {};

    // Scrape title. WARNING: mangles the DOM
    let subtitle;
    let subtitleNode = $('.ncd-subtitle');
    if (subtitleNode.length) {
      subtitle = subtitleNode.text().trim();
      subtitleNode.remove();
    }

    o.title = $('.ncd-title').text().trim();

    if (subtitle) {
      o.subtitle = subtitle;
    }

    o.table = this.scrapeTable();
    o.matrix = this.scrapeMatrix();
    o.rc = this.scrapeRC();

    return o;
  }
}

class ResultPage extends Page {
  scrape() {
    let $ = this.$;
    let o = [];
    let rows = [].slice.call(this.$('#ClassificationList tr[id=print-dashed-separator]'));

    for (let row of rows) {
      row = $(row);

      let btn = row.find('.item-title input');

      o.push({
        title: row.find('.item-title a').text().trim(),
        date: row.find('.item-date').text().trim(),
        category: row.find('.item-category').text().trim().split('\n')[0].trim(),
        rating: row.find('.item-rating img').attr('alt'),

        link: {
          name: btn.attr('name'),
          value: btn.attr('value')
        }
      });
    }

    return o;
  }

  resolveSiblings() {
    let self = this;

    let hrefs = [].slice.call(this.$('.pager-numeric').map(function() {
      return self.$(this).attr('href')
                .replace("javascript:__doPostBack('", '')
                .replace("','')", '');
    }));

    return hrefs.map(function() {
      let href = this;

      return co(function*() {
        let formData = this.getFormData();
        formData.__EVENTTARGET = href;

        let res = this.postForm(formData);
        res = yield res;
        return new ResultPage(res);
      }.bind(self));
    });
  }

  nextPage() {
    return co(function*() {
      let formData = this.getFormData();

      let href = this.$('.pager-ctl a:last-child').attr('href');

      if (href == null) {
        return null;
      }

      href = href.replace("javascript:__doPostBack('", '').replace("','')", '');
      formData.__EVENTTARGET = href;

      let res = yield this.postForm(formData);
      return new ResultPage(res);
    }.bind(this));
  }

  getTitlePage(name, value) {
    return co(function*() {
      let formData = this.getFormData();
      formData[name] = value;

      let res = yield this.postForm(formData);
      return new TitlePage(res);
    }.bind(this));
  }

  getTitlePages() {
    return co(function*() {
      let self = this;

      return yield this.data.map(function(item) {
        return self.getTitlePage(item.link.name, item.link.value);
      });
    }.bind(this));
  }

  sortByOldest() {
    return co(function*() {
      let formData = this.getFormData();

      formData[this.getFieldName('QueryTarget')] = 'lfc';
      formData[this.getFieldName('SortDateOldest$AccessibleLink')] = 'date+(oldest)';

      return new ResultPage(yield this.postForm(formData));
    }.bind(this));
  }

  get startIndex() {
    return parseInt(this.$('[id*=PageStartIndexLabel]').text(), 10);
  }

  get endIndex() {
    return parseInt(this.$('[id*=PageEndIndexLabel]').text(), 10);
  }

  get total() {
    let node = this.$('[id*=TotalRowsLabel]');
    if (node.length) {
      return parseInt(node.text(), 10);
    }
  }

  get searchQuery() {
    let node = this.$('[id$=SummaryPager]');

    if (node.length) {
      return node.text().split(':')[1].trim();
    }
  }
}

class SearchPage extends Page {
  static get URL() {
    return 'http://www.classification.gov.au/Pages/Search.aspx';
  }

  static resolve() {
    return co(function*() {
      let res = yield request.agent(http.globalAgent).get(SearchPage.URL);

      return new SearchPage(res);
    });
  }

  searchYear(year) {
    return co(function*() {
      let $ = this.$;

      $('[id*=DateFromTextbox]').attr('value', year);
      $('[id*=DateToTextbox]').attr('value', year + 1);
      $('[id*=RestrictedCheckbox]').attr('checked', true);

      let formData = this.getFormData();
      let prefix = this.$('[id*=DateToTextbox]').attr('name').replace('DateToTextbox', '');
      formData[prefix + 'SearchButton'] = '';

      let res = yield this.postForm(formData); //request.post(SearchPage.URL).redirects().type('form').send(formData);
      return new ResultPage(res);
    }.bind(this));
  }
}

process.on('unhandledRejection', function(err) {
  Log.e(TAG, 'unhandled promise rejection', err);
});

let ScraperSymbol = Symbol('Scraper');

class Scraper {
  static create() {
    return co(function*() {
      let s = new Scraper(ScraperSymbol);

      s.searchPage = yield SearchPage.resolve();
      s.collection = db.collection('classifications');

      return s;
    });
  }

  constructor(symbol) {
    if (symbol !== ScraperSymbol) {
      throw new TypeError('Cannot be instantiated with new. Use static `create` method.');
    }
  }

  scrapeYear(y) {
    return co(function*() {
      let yText = '[' + y + ']';
      let resultPage = yield this.searchPage.searchYear(y);
      Log.i(TAG, yText, 'Total records:', resultPage.total);

      resultPage = yield resultPage.sortByOldest();
      Log.i(TAG, yText, 'Sorted by oldest.');

      while (resultPage) {
        Log.i(TAG, yText, resultPage.startIndex, '-', resultPage.endIndex);

        let titlePages = yield resultPage.getTitlePages();
        let r = yield this.collection.insertMany(titlePages.map(function(tp) {
          return tp.data;
        }));

        Log.i(TAG, yText, 'Saved', r.insertedIds.length, 'titles.');

        Log.i(TAG, yText, 'Resolving next page…');
        resultPage = yield resultPage.nextPage();
      }

      Log.i(TAG, yText, 'No more pages. Done!');
    }.bind(this));
  }

  start(y) {
    y = y || 1971;

    return co(function*() {
      let thisYear = (new Date).getFullYear();
      for (let i = y; i <= thisYear; ++i) {
        yield this.scrapeYear(i);
      }
    }.bind(this));
  }
}

co(function*() {
  db = yield mongodb.MongoClient.connect('mongodb://localhost:27017/scrapo');

  let scraper = yield Scraper.create();

  yield scraper.start(2014);

  /*
  let search = yield SearchPage.resolve();

  let results = yield search.searchYear(2014);

  Log.i(TAG, 'Oh');
  try {
    let foo = yield results.resolveSiblings();
    Log.i(TAG, 'Oh', foo.length);
  } catch (err) {
    Log.e(TAG, err);
  }
  */

  process.exit(0);
}).catch(function(err) {
  Log.wtf(TAG, err);
});
