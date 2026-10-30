import moment from 'moment';

export function formatDue(due) {
  return moment(due).format('MMM D');
}
